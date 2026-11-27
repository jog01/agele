import { describe, expect, it } from "bun:test";
import { curveProgress } from "../src/services/chain-ingest/curve-progress";
import { decodeTransaction } from "../src/services/chain-ingest/decode";
import { PROGRAMS, SOL } from "../src/services/chain-ingest/programs";
import { normalizeTransaction } from "../src/services/chain-ingest/transaction";
import dammV1 from "./fixtures/yellowstone/meteora-damm-v1.json";
import dammV2 from "./fixtures/yellowstone/meteora-damm-v2.json";
import dlmm from "./fixtures/yellowstone/meteora-dlmm.json";
import launch from "./fixtures/yellowstone/pump-launch.json";
import migration from "./fixtures/yellowstone/pump-migrate.json";
import noopMigration from "./fixtures/yellowstone/pump-migrate-noop.json";
import pump from "./fixtures/yellowstone/pump-trade.json";
import pumpSwap from "./fixtures/yellowstone/pumpswap.json";
import clmm from "./fixtures/yellowstone/raydium-clmm.json";
import cpmm from "./fixtures/yellowstone/raydium-cpmm.json";
import raydium from "./fixtures/yellowstone/raydium-v4.json";
import { type Recording, recordedTransaction } from "./fixtures/yellowstone-recording";

function decodeObservations(recording: Recording) {
  const tx = normalizeTransaction(
    recordedTransaction(recording),
    recording.rpc.slot,
    recording.rpc.blockTime,
  );
  expect(tx).toBeDefined();
  return decodeTransaction(tx!);
}

function decode(recording: Recording) {
  return decodeObservations(recording).map(({ event }) => event);
}

describe("recorded finalized Solana transactions", () => {
  it.each([
    ["pump.fun", PROGRAMS.pump, pump, 3, "sell", "52743595734588", "51708489", 6, 9],
    ["pumpswap", PROGRAMS.pumpSwap, pumpSwap, 5, "sell", "1256874003", "1170704", 6, 9],
    ["raydium-v4", PROGRAMS.raydiumV4, raydium, 8, "sell", "1230081113", "2022259", 6, 9],
    ["raydium-cpmm", PROGRAMS.raydiumCpmm, cpmm, 14, "buy", "105802616439", "27643036", 6, 9],
    ["meteora-dlmm", PROGRAMS.meteoraDlmm, dlmm, 4, "buy", "248055399778", "1388503193", 12, 9],
    ["meteora-damm", PROGRAMS.meteoraDammV1, dammV1, 4, "buy", "66479515887", "344424542", 9, 9],
    ["meteora-damm", PROGRAMS.meteoraDammV2, dammV2, 3, "buy", "220643084490695", "670000", 6, 9],
  ] as const)(
    "%s (%s) decodes executed amounts rather than instruction limits",
    (venue, programId, recording, eventIndex, side, baseRaw, quoteRaw, baseDecimals, quoteDecimals) => {
      const events = decode(recording);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        source: "solana",
        kind: "Trade",
        signature: recording.rpc.transaction.signatures[0],
        slot: recording.rpc.slot,
        transactionIndex: recording.transactionIndex,
        blockTime: recording.rpc.blockTime,
        eventIndex,
        market: { venue, programId },
        side,
        base: { raw: baseRaw, decimals: baseDecimals },
        quote: { mint: SOL, raw: quoteRaw, decimals: quoteDecimals },
      });
    },
  );

  it("keeps distinct CPI fills in execution order through an ALT-backed three-venue route", () => {
    const events = decode(clmm);
    expect(events).toHaveLength(3);
    expect(events).toMatchObject([
      {
        eventIndex: 15,
        market: { venue: "pump.fun" },
        side: "sell",
        base: { raw: "344762575004" },
        quote: { raw: "1378597", decimals: 8 },
      },
      {
        eventIndex: 20,
        market: { venue: "raydium-clmm" },
        side: "sell",
        base: { raw: "1378597" },
        quote: { raw: "3960230", decimals: 6 },
      },
      {
        eventIndex: 23,
        market: { venue: "pumpswap" },
        side: "sell",
        base: { raw: "3960230" },
        quote: { raw: "55015959", decimals: 9 },
      },
    ]);
  });

  it("emits the Pump launch followed by the creator's buy in the same transaction", () => {
    const events = decode(launch);
    expect(events).toHaveLength(2);
    expect(events).toMatchObject([
      {
        kind: "TokenLaunched",
        eventIndex: 0,
        decimals: 6,
        mint: "1xxECuEV77SeVeY9XXVNr8wBRYT6bFYNbkeAsLSpump",
        creator: "EUA3BRvTAWPKEcxhm7tCEppuNoevSBMCfKLaXAiAPNKA",
        market: { address: "G9E6DLeXmbW9vvHZw6vPfbAyvjN7XiD6pM5BAiGJiSJy" },
      },
      {
        kind: "Trade",
        eventIndex: 21,
        side: "buy",
        base: { raw: "112104477611940" },
        quote: { mint: SOL, raw: "3500000000" },
      },
    ]);
  });

  it("reports the actual PumpSwap migration but not a successful idempotent repeat", () => {
    const events = decode(migration);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "Migrated",
      mint: "8EQHN5TYWjg43SoQVZaH6JUzMMLE6P9KtE8DvQLKpump",
      from: { address: "GUWBH38LtM6yEjFGnAmzSCpnFGBTajtwjszRCyi4Xsvr", venue: "pump.fun" },
      to: { address: "95pYX8NUvyENzAVTr6FyWNyEgk1cmFoRwvwPbrxfuEFf", venue: "pumpswap" },
    });
    expect(events[1]).toMatchObject({ kind: "Trade", side: "buy", market: { venue: "pumpswap" } });
    expect(decode(noopMigration)).toEqual([]);
  });

  it("computes live curve progress from recorded launch and fill reserves without guessing unknown starts", async () => {
    const [creation, trade] = decodeObservations(launch);
    const starts = new Map<string, bigint>();
    const store = {
      async load() {
        return starts;
      },
      async remember(entries: ReadonlyMap<string, bigint>) {
        for (const [curve, reserve] of entries) starts.set(curve, reserve);
      },
    };
    expect(await curveProgress([trade!], store)).toEqual([trade!.event]);
    const [, sameBlock] = await curveProgress([creation!, trade!], store);
    expect(sameBlock).toMatchObject({ curveProgressBps: 1413 });
    expect(await curveProgress([trade!], store)).toEqual([sameBlock!]);
  });

  it("ignores failed transactions and does not guess CPI ownership when stack heights are absent", () => {
    const failed = recordedTransaction(pump);
    failed.meta!.err = { err: Uint8Array.of(1) };
    expect(normalizeTransaction(failed, pump.rpc.slot, null)).toBeUndefined();
    const ambiguous = recordedTransaction(clmm);
    for (const group of ambiguous.meta!.innerInstructions) {
      for (const ix of group.instructions) ix.stackHeight = undefined;
    }
    expect(decodeTransaction(normalizeTransaction(ambiguous, clmm.rpc.slot, null)!)).toEqual([]);
  });
});
