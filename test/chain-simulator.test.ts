import { describe, expect, it } from "bun:test";
import { getBase58Encoder } from "@solana/kit";
import { createChainIngest } from "../src/services/chain-ingest";
import type { ChainEvent } from "../src/services/chain-ingest/events";
import { resolveMetadata } from "../src/services/chain-ingest/metadata";
import { Curve, DemoChainSimulator, DemoSolUsdPrice } from "../src/services/chain-ingest/simulator";
import { ChainEventSchema } from "../src/services/chain-ingest/validation";

const wallet = "11111111111111111111111111111111";
const now = () => 1_800_000_005_000;

async function generate(seed: number) {
  const stop = new AbortController();
  const result: ChainEvent[] = [];
  await new DemoChainSimulator({ seed, now, traders: [wallet] }).run(
    {
      ingest: async (events) => {
        result.push(...events);
        if (events.some((event) => event.blockTime === now() / 1000)) stop.abort();
      },
    },
    stop.signal,
  );
  return result;
}

describe("demo chain simulator", () => {
  it("selects the simulator, demo price and local chain facts together", async () => {
    const { source, solUsd, facts } = createChainIngest({ CHAIN_SOURCE: "demo" });
    expect(source).toBeInstanceOf(DemoChainSimulator);
    expect(await solUsd.getSolUsd(now() / 1000)).toBe(new DemoSolUsdPrice().getSolUsd(now() / 1000));
    expect(await facts.blockTime((now() / 1000) * 3)).toBe(now() / 1000);
  });

  it("is deterministic, backfills history, uses shared trader wallets and emits migrations followed by swaps", async () => {
    const events = await generate(73);
    const history = (entries: ChainEvent[]) => entries.filter((entry) => entry.blockTime !== now() / 1000);
    expect(history(await generate(73))).toEqual(history(events));
    expect((await generate(74))[0]).not.toEqual(events[0]);
    const launch = events.find((event) => event.kind === "TokenLaunched")!;
    expect(launch.blockTime).toBeLessThan(now() / 1000 - 10_000);
    expect(launch.creator).toBe(wallet);
    expect((await resolveMetadata(launch.metadataUri))?.imageUrl).toStartWith("https://");
    const migration = events.find((event) => event.kind === "Migrated")!;
    expect(migration?.to.venue).toBe("pumpswap");
    const migrated = new Set(events.filter((event) => event.kind === "Migrated").map((event) => event.mint));
    expect(
      events.some(
        (event) =>
          event.kind === "Trade" && (event.curveProgressBps ?? 0) >= 7000 && !migrated.has(event.mint),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "Trade" &&
          event.mint === migration.mint &&
          event.market.venue === "pumpswap" &&
          event.curveProgressBps === undefined &&
          event.trader === wallet,
      ),
    ).toBe(true);
    const encoder = getBase58Encoder();
    for (const event of events) {
      expect(ChainEventSchema.safeParse(event).success).toBe(true);
      expect(encoder.encode(event.signature)).toHaveLength(64);
      expect(encoder.encode(event.mint)).toHaveLength(32);
    }
  });

  it("emits new live transaction identities on a restart in the same epoch", async () => {
    const first = (await generate(73)).filter((event) => event.blockTime === now() / 1000);
    const restarted = (await generate(73)).filter((event) => event.blockTime === now() / 1000);
    const keys = new Set(first.map(({ signature, eventIndex }) => `${signature}:${eventIndex}`));
    expect(first.some((event) => event.kind === "Trade")).toBe(true);
    expect(restarted.some((event) => event.kind === "Trade")).toBe(true);
    expect(restarted.filter(({ signature, eventIndex }) => keys.has(`${signature}:${eventIndex}`))).toEqual(
      [],
    );
  });

  it("uses virtual constant product reserves, caps graduation at 85 SOL and allows post-migration trading", () => {
    const curve = new Curve();
    expect(curve.sell(1000n)).toBeNull();
    const first = curve.buy(30_000_000_000n)!;
    expect(first.tokens).toBe(536_500_000_000_000n);
    expect(curve.progressBps).toBe(3529);
    expect(curve.sell(first.tokens / 2n)?.sol).toBe(20_000_000_000n);
    expect(curve.buy(100_000_000_000n)?.sol).toBe(75_000_000_000n);
    expect(curve.progressBps).toBe(10_000);
    expect(curve.buy(1_000_000_000n)).toBeNull();
    curve.migrate();
    expect(curve.buy(1_000_000_000n)?.tokens).toBeGreaterThan(0n);
  });

  it("does not emit after an already-aborted signal and supplies a repeatable SOL/USD walk", async () => {
    let called = false;
    await new DemoChainSimulator().run(
      {
        ingest: async () => {
          called = true;
        },
      },
      AbortSignal.abort(),
    );
    expect(called).toBe(false);
    const walk = new DemoSolUsdPrice();
    const quote = walk.getSolUsd(now() / 1000);
    expect(quote).toBeGreaterThan(170);
    expect(quote).toBeLessThan(190);
    expect(quote).toBe(new DemoSolUsdPrice().getSolUsd(now() / 1000));
    expect(quote).not.toBe(walk.getSolUsd(now() / 1000 + 120));
  });

  it("accepts IPFS and data metadata, rejects unsafe schemes and discards invalid or oversized data", async () => {
    const payload = JSON.stringify({ name: "Cloud Otter", symbol: "COTR", image: "ipfs://image" });
    expect(
      await resolveMetadata(`data:application/json;base64,${Buffer.from(payload).toString("base64")}`),
    ).toMatchObject({ imageUrl: "https://ipfs.io/ipfs/image" });
    expect(
      await resolveMetadata("ipfs://metadata", async (url) => {
        expect(url.href).toBe("https://ipfs.io/ipfs/metadata");
        return payload;
      }),
    ).toMatchObject({ symbol: "COTR" });
    expect(await resolveMetadata("http://example.org/token.json")).toBeNull();
    expect(await resolveMetadata("https://127.0.0.1/token.json")).toBeNull();
    expect(await resolveMetadata("data:application/json,{}")).toBeNull();
    expect(
      await resolveMetadata("https://example.org/token.json", async () => "x".repeat(140_000)),
    ).toBeNull();
  });
});
