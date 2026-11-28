import { afterAll, describe, expect, it } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { asc, inArray, like } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { AppError } from "../src/lib/errors";
import { chainCandles, chainEvents, chainTokens, chainTrades } from "../src/models/chain";
import { PulseEventSchema, PulseSchema, TokenSchema } from "../src/schemas/token";
import { demoMetadataUri, demoTokenImage } from "../src/services/chain-ingest/demo-metadata";
import { readDemoState } from "../src/services/chain-ingest/demo-state";
import type { ChainEvent, EventRef } from "../src/services/chain-ingest/events";
import { resolveMetadata } from "../src/services/chain-ingest/metadata";
import { IngestService } from "../src/services/chain-ingest/service";
import { DemoSolUsdPrice } from "../src/services/chain-ingest/simulator";
import { IndexedMarketDataProvider } from "../src/services/market-data/indexed.provider";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TokenService } from "../src/services/token.service";
import { SOL, testApp } from "./helpers";

const db = getDb();
const prefix = `chain-test-${crypto.randomUUID()}`;
const mints: string[] = [];
const newMint = () => {
  const mint = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  mints.push(mint);
  return mint;
};
const time = 1_800_000_000;
const creator = "11111111111111111111111111111111";
const market = { venue: "pump.fun", address: creator, programId: creator } as const;
const nextMarket = { ...market, venue: "pumpswap" } as const;
const metadataUri =
  "data:application/json," +
  encodeURIComponent(
    JSON.stringify({
      name: "Pocket Otter",
      symbol: "POTR",
      image: "https://example.org/otter.png",
    }),
  );
const facts = { blockTime: async () => time, tokenSupply: async () => "1000000000" };
const solUsd = { getSolUsd: () => 200 };

function launch(
  mint: string,
  source: EventRef["source"] = "demo",
): Extract<ChainEvent, { kind: "TokenLaunched" }> {
  return {
    kind: "TokenLaunched",
    source,
    mint,
    market,
    creator,
    decimals: 6,
    metadataUri,
    blockTime: null,
    signature: `${prefix}-${mint}`,
    slot: 1,
    transactionIndex: 0,
    eventIndex: 0,
  };
}

function trade(
  token: ReturnType<typeof launch>,
  index: number,
  progress = 7000,
  lamports = 1_000_000_000,
  side: "buy" | "sell" = "buy",
  delta = 0,
): Extract<ChainEvent, { kind: "Trade" }> {
  return {
    ...token,
    kind: "Trade",
    side,
    trader: creator,
    eventIndex: index,
    blockTime: time + delta,
    curveProgressBps: progress,
    base: { mint: token.mint, raw: "2000000", decimals: 6 },
    quote: { mint: SOL, raw: String(lamports), decimals: 9 },
  };
}

function setup() {
  const sent: { topic: string; data: unknown }[] = [];
  let now = (time + 100) * 1000;
  const upstream = new MockMarketDataProvider(() => now);
  const indexed = new IndexedMarketDataProvider(db, { source: "solana", upstream, solUsd, now: () => now });
  const sink = new IngestService(
    db,
    {
      publish: (topic, data) => {
        sent.push({ topic, data });
      },
    },
    solUsd,
    facts,
    () => now,
  );
  return {
    sent,
    sink,
    indexed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterAll(async () => {
  if (!mints.length) return;
  await db.delete(chainCandles).where(inArray(chainCandles.mint, mints));
  await db.delete(chainTrades).where(inArray(chainTrades.mint, mints));
  await db.delete(chainTokens).where(inArray(chainTokens.mint, mints));
  await db.delete(chainEvents).where(like(chainEvents.signature, `${prefix}%`));
});

describe("chain ingestion and indexed market data", () => {
  it("repairs duplicate simulator metadata without renaming the first mint or touching live rows", async () => {
    const { sink } = setup();
    const label = { name: `Cloud Duck ${prefix}`, symbol: "CLOUDDUCKTEST" };
    const first = newMint();
    const second = newMint();
    const live = newMint();
    const token = (mint: string, offset: number, source: EventRef["source"]) => ({
      ...launch(mint, source),
      slot: 1 + offset,
      blockTime: time + offset,
      metadataUri: demoMetadataUri(label, demoTokenImage(mint)),
    });
    await sink.ingest([token(first, 0, "demo"), token(second, 1, "demo"), token(live, 2, "solana")]);
    const rows = () =>
      db
        .select()
        .from(chainTokens)
        .where(inArray(chainTokens.mint, [first, second, live]))
        .orderBy(asc(chainTokens.launchedAt));

    const state = await readDemoState(db);
    const repaired = await rows();
    const [original, renamed, unchangedLive] = repaired;
    expect(original).toMatchObject({ mint: first, ...label });
    expect(unchangedLive).toMatchObject({ mint: live, ...label });
    const tag = second.slice(0, 5).toUpperCase();
    const changed = { name: `${label.name} · ${tag}`, symbol: `${label.symbol}-${tag}` };
    expect(renamed).toMatchObject({ mint: second, ...changed, imageUrl: demoTokenImage(second) });
    expect(await resolveMetadata(renamed?.metadataUri ?? undefined)).toMatchObject(changed);
    expect(state?.labels).toContainEqual(label);
    expect(state?.labels).toContainEqual(changed);
    await readDemoState(db);
    expect(await rows()).toEqual(repaired);
  });

  it("stores stages, exact and prefix search, 24h statistics, net holders, and own OHLCV without double counting", async () => {
    const { sent, sink, indexed, advance } = setup();
    const token = launch(newMint(), "solana");
    const first = trade(token, 1, 6900);
    const second = trade(token, 2, 7000, 2_000_000_000);
    const third = trade(token, 3, 8000, 500_000_000, "sell", 75);
    await sink.ingest([token]);
    expect((await indexed.listPulse(100)).new.find((t) => t.mint === token.mint)?.imageUrl).toBe(
      "https://example.org/otter.png",
    );
    expect(await indexed.getCandles(token.mint, "1m", 10)).toEqual([]);
    await sink.ingest([second]);
    await sink.ingest([first]); // A late fill still sets the earlier open.
    expect(sent.filter((event) => event.topic === "pulse")).toHaveLength(1);
    advance(1000);
    await sink.ingest([third]);
    const pulse = (await indexed.listPulse(100)).finalStretch.find((t) => t.mint === token.mint);
    expect(pulse).toMatchObject({
      curveProgressBps: 8000,
      txCount24h: 3,
      buys24h: 2,
      sells24h: 1,
      volume24hUsd: 700,
      holders: 1,
    });
    expect(sent.filter((event) => event.topic === "pulse")).toHaveLength(2);
    const migration = {
      ...token,
      kind: "Migrated",
      from: market,
      to: nextMarket,
      eventIndex: 4,
      blockTime: time + 76,
    } as const;
    await sink.ingest([migration]);
    const notifications = sent.length;
    await sink.ingest([token, first, second, third, migration]);
    expect(sent).toHaveLength(notifications);
    expect(
      sent.filter((event) => event.topic === "pulse").map((entry) => PulseEventSchema.parse(entry.data).type),
    ).toEqual(["upsert", "upsert", "migrated"]);
    expect((await indexed.listPulse(100)).migrated.find((t) => t.mint === token.mint)).toMatchObject({
      stage: "migrated",
      migratedVenue: "pumpswap",
      migratedAt: time + 76,
    });
    expect((await indexed.getRecentTrades(token.mint, 10)).map((entry) => entry.priceUsd)).toEqual([
      50, 200, 100,
    ]);
    expect(await indexed.getCandles(token.mint, "1m", 10)).toEqual([
      { time, open: 100, high: 200, low: 100, close: 200, volume: 600 },
      { time: time + 60, open: 50, high: 50, low: 50, close: 50, volume: 100 },
    ]);
    expect(await indexed.getCandles(token.mint, "5m", 10)).toEqual([
      { time, open: 100, high: 200, low: 50, close: 50, volume: 700 },
    ]);
    expect(await indexed.getHistoricalPriceUsd(token.mint, time)).toBe(100);
    expect(await indexed.getHistoricalPriceUsd(token.mint, time + 120)).toBeNull();
    const holders = await indexed.getHolders(token.mint, 1);
    expect(holders).toMatchObject({
      totalHolders: 1,
      holders: [{ wallet: creator, amount: 2, valueUsd: 100 }],
    });
    expect((await indexed.listTrending(100)).some((item) => item.mint === token.mint)).toBe(true);
    expect((await indexed.searchTokens(token.mint))[0]?.mint).toBe(token.mint);
    expect((await indexed.searchTokens("pOcKeT")).some((item) => item.mint === token.mint)).toBe(true);
    expect(await indexed.searchTokens("PO%")).toEqual([]);
    expect((await indexed.getToken(SOL))?.mint).toBe(SOL);
    const demoIndexed = new IndexedMarketDataProvider(db, {
      source: "demo",
      solUsd,
      upstream: new MockMarketDataProvider(),
    });
    expect((await demoIndexed.getToken(SOL))?.priceUsd).toBe(200);
    expect(await demoIndexed.getHistoricalPriceUsd(SOL, time)).toBe(200);
  });

  it("scopes receipts by source, rolls back failed batches, rejects unsorted events and accepts empty input", async () => {
    const { sink, indexed } = setup();
    const token = launch(newMint(), "solana");
    const counterpart = { ...token, source: "demo" } as const;
    await sink.ingest([]);
    await expect(sink.ingest([trade(token, 2), token])).rejects.toThrow("not in slot");
    await expect(sink.ingest([token, trade(token, 1, 6900, 0)])).rejects.toThrow("Invalid trade amount");
    expect(await indexed.getToken(token.mint)).toBeNull();
    await sink.ingest([counterpart, token, trade(token, 1)]);
    expect(await indexed.getRecentTrades(token.mint, 10)).toHaveLength(1);
    const other = new IndexedMarketDataProvider(db, {
      source: "demo",
      solUsd,
      upstream: new MockMarketDataProvider(),
    });
    expect((await other.getToken(token.mint))?.priceUsd).toBe(0);
  });

  it("merges indexed prefix results with upstream search, dedupes, and ranks exact mints first", async () => {
    const { sink } = setup();
    const token = launch(newMint());
    const localMetadata = { name: "Solar Otter", symbol: "SOLATO" };
    await sink.ingest([
      { ...token, metadataUri: `data:application/json,${encodeURIComponent(JSON.stringify(localMetadata))}` },
    ]);
    const mock = new MockMarketDataProvider();
    const sol = (await mock.getToken(SOL))!;
    const upstream = Object.assign(mock, { searchTokens: async () => [{ ...sol, mint: token.mint }, sol] });
    const indexed = new IndexedMarketDataProvider(db, { source: "demo", upstream, solUsd });
    const results = await indexed.searchTokens("SOL");
    expect(results.filter(({ mint }) => mint === token.mint)).toEqual([
      expect.objectContaining(localMetadata),
    ]);
    const detail = (await indexed.getToken(SOL))!;
    expect(results.find(({ mint }) => mint === SOL)).toEqual(detail);
    expect((await indexed.searchTokens(SOL))[0]).toEqual(detail);
    expect((await indexed.searchTokens(SOL)).map(({ mint }) => mint)).toEqual([SOL, token.mint]);
    upstream.searchTokens = async () => {
      throw new Error("upstream unavailable");
    };
    expect((await indexed.searchTokens("SOL")).some(({ mint }) => mint === token.mint)).toBe(true);
    const app = testApp({ tokens: new TokenService(indexed) });
    const partial = await app.request("/v1/search?q=SOL");
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      tokens: expect.arrayContaining([expect.objectContaining({ mint: token.mint })]),
      tokensUnavailable: true,
    });
    await expect(indexed.searchTokens("no-result")).rejects.toThrow("upstream unavailable");
  });

  it.each(["demo", "solana"] as const)("finds native SOL by name, symbol and mint for %s", async (source) => {
    let unavailable = false;
    const upstream = new LiveMarketDataProvider({
      fetch: async (url) => {
        expect(new URL(url).pathname).toBe("/tokens/v2/search");
        return unavailable ? new Response(null, { status: 503 }) : Response.json([]);
      },
    });
    const indexed = new IndexedMarketDataProvider(db, { source, solUsd, upstream });
    const app = testApp({ tokens: new TokenService(indexed) });
    for (const q of ["sOL", "Solana", SOL]) {
      const response = await app.request(`/v1/search?q=${q}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tokens: expect.arrayContaining([
          expect.objectContaining({ mint: SOL, name: "Solana", symbol: "SOL", priceUsd: 200 }),
        ]),
        tokensUnavailable: false,
      });
    }
    unavailable = true;
    const response = await app.request("/v1/search?q=solan");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tokens: expect.arrayContaining([expect.objectContaining({ mint: SOL })]),
      tokensUnavailable: true,
    });
  });

  it("serves native SOL candles from the simulator's SOL/USD history without an upstream key", async () => {
    const solUsd = new DemoSolUsdPrice();
    const now = () => (time + 65) * 1000;
    const upstream = new LiveMarketDataProvider({
      fetch: async () => {
        throw new Error("Native SOL candles should not require a remote request");
      },
    });
    const indexed = new IndexedMarketDataProvider(db, { source: "demo", solUsd, upstream, now });
    const app = testApp({ tokens: new TokenService(indexed) });
    const response = await app.request(`/v1/tokens/${SOL}/candles?interval=5m&limit=2`);
    expect(response.status).toBe(200);
    const prices = Array.from({ length: 5 }, (_, i) => solUsd.getSolUsd(time - 300 + i * 60));
    expect(await response.json()).toEqual({
      candles: [
        {
          time: time - 300,
          open: expect.closeTo(prices[0]!, 10),
          high: expect.closeTo(Math.max(...prices), 10),
          low: expect.closeTo(Math.min(...prices), 10),
          close: expect.closeTo(prices[4]!, 10),
          volume: 0,
        },
        {
          time,
          open: expect.closeTo(solUsd.getSolUsd(time), 10),
          high: expect.closeTo(Math.max(solUsd.getSolUsd(time), solUsd.getSolUsd(time + 60)), 10),
          low: expect.closeTo(Math.min(solUsd.getSolUsd(time), solUsd.getSolUsd(time + 60)), 10),
          close: expect.closeTo(solUsd.getSolUsd(time + 60), 10),
          volume: 0,
        },
      ],
    });
  });

  it("preserves the upstream name when searching for the Wrapped SOL prefix", async () => {
    const upstream = new LiveMarketDataProvider({
      fetch: async (url) =>
        new URL(url).pathname === "/tokens/v2/search"
          ? Response.json([{ id: SOL, name: "Wrapped SOL", symbol: "SOL", decimals: 9 }])
          : Response.json({ [SOL]: { usdPrice: 201 } }),
    });
    const indexed = new IndexedMarketDataProvider(db, { source: "demo", upstream, solUsd });
    const app = testApp({ tokens: new TokenService(indexed) });
    const detail = await app.request(`/v1/tokens/${SOL}`);
    expect(detail.status).toBe(200);
    const { priceUsd } = TokenSchema.parse(await detail.json());
    expect(priceUsd).toBe(200);
    for (const path of ["/v1/search", "/v1/tokens/search"]) {
      const response = await app.request(`${path}?q=wRaPpEd`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        tokens: [expect.objectContaining({ mint: SOL, name: "Wrapped SOL", symbol: "SOL", priceUsd })],
      });
      const canonical = await app.request(`${path}?q=Solana`);
      expect(canonical.status).toBe(200);
      expect(await canonical.json()).toMatchObject({
        tokens: expect.arrayContaining([expect.objectContaining({ mint: SOL, priceUsd })]),
      });
    }
  });

  it("uses upstream OHLCV for native SOL when the source does not provide local history", async () => {
    const upstream = new LiveMarketDataProvider({
      now: () => (time + 60) * 1000,
      birdeyeApiKey: "test-key",
      fetch: async (url) => {
        const { pathname, searchParams } = new URL(url);
        if (pathname === "/tokens/v2/search") return Response.json([]);
        expect(pathname).toBe("/defi/v3/ohlcv");
        expect(searchParams.get("address")).toBe(SOL);
        return Response.json({
          success: true,
          data: { items: [{ unix_time: time, o: 100, h: 105, l: 95, c: 102, v_usd: 250 }] },
        });
      },
    });
    const indexed = new IndexedMarketDataProvider(db, { source: "solana", upstream, solUsd });
    const app = testApp({ tokens: new TokenService(indexed) });
    const response = await app.request(`/v1/tokens/${SOL}/candles?interval=1m&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candles: [{ time, open: 100, high: 105, low: 95, close: 102, volume: 250 }],
    });
  });

  it("commits known launches and trades even when the live stream starts after another mint launched", async () => {
    const { sink, indexed } = setup();
    const existing = launch(newMint(), "solana");
    const fresh = launch(newMint(), "solana");
    const existingTrade = { ...trade(existing, 1), transactionIndex: 0 };
    const freshLaunch = { ...fresh, transactionIndex: 1 };
    const freshTrade = { ...trade(fresh, 1), transactionIndex: 1 };
    await sink.ingest([existingTrade, freshLaunch, freshTrade]);
    expect(await indexed.getRecentTrades(fresh.mint, 10)).toHaveLength(1);
    expect(await indexed.getToken(existing.mint)).toBeNull();
    await sink.ingest([existing, existingTrade]);
    expect(await indexed.getRecentTrades(existing.mint, 10)).toHaveLength(1);
  });

  it("sanitizes creator-provided metadata and commits the other launches in the batch", async () => {
    const { sink } = setup();
    const dirty = launch(newMint(), "solana");
    const invalid = launch(newMint(), "solana");
    const oversized = launch(newMint(), "solana");
    const clean = launch(newMint(), "solana");
    const dataUri = (name: string, symbol: string) =>
      `data:application/json,${encodeURIComponent(JSON.stringify({ name, symbol }))}`;
    await sink.ingest([
      { ...dirty, metadataUri: dataUri("  Ot\0ter\n Coin  ", "\rO\u0085TR \t") },
      { ...invalid, metadataUri: "data:application/json,{\0" },
      { ...oversized, metadataUri: dataUri("Too long", "X".repeat(33)) },
      clean,
    ]);
    const rows = await db
      .select()
      .from(chainTokens)
      .where(inArray(chainTokens.mint, [dirty.mint, invalid.mint, oversized.mint, clean.mint]));
    const byMint = new Map(rows.map((row) => [row.mint, row]));
    expect(byMint.get(dirty.mint)).toMatchObject({ name: "Otter Coin", symbol: "OTR" });
    expect(byMint.get(invalid.mint)).toMatchObject({
      name: invalid.mint,
      symbol: "Unknown",
      imageUrl: null,
      metadataUri: null,
    });
    expect(byMint.get(oversized.mint)).toMatchObject({
      name: oversized.mint,
      symbol: "Unknown",
      imageUrl: null,
    });
    expect(byMint.get(clean.mint)).toMatchObject({ name: "Pocket Otter", symbol: "POTR" });
  });

  it("uses upstream pricing and history for a live launch until its first stored SOL trade", async () => {
    const { sink } = setup();
    const token = launch(newMint(), "solana");
    const mock = new MockMarketDataProvider(() => time * 1000);
    const price = { ...(await mock.getToken(SOL))!, mint: token.mint };
    const upstream = Object.assign(mock, { searchTokens: async () => [price] });
    const candles = await upstream.getCandles(SOL, "1m", 1);
    const trades = (await upstream.getRecentTrades(SOL, 1)).map((fill) => ({ ...fill, mint: token.mint }));
    const holders = { ...(await upstream.getHolders(SOL, 1)), mint: token.mint };
    upstream.getToken = async () => price;
    upstream.getCandles = async () => candles;
    upstream.getRecentTrades = async () => trades;
    upstream.getHolders = async () => holders;
    const indexed = new IndexedMarketDataProvider(db, { source: "solana", upstream, solUsd });
    const first = trade(token, 1);
    await sink.ingest([token, { ...first, quote: { ...first.quote, mint: creator } }]);
    expect(await indexed.getToken(token.mint)).toEqual(price);
    expect(await indexed.searchTokens(token.mint)).toEqual([price]);
    expect(await indexed.getExternalToken(token.mint)).toEqual(price);
    expect(await indexed.getCandles(token.mint, "1m", 1)).toEqual(candles);
    expect(await indexed.getRecentTrades(token.mint, 1)).toEqual(trades);
    expect(await indexed.getHolders(token.mint, 1)).toEqual(holders);

    await sink.ingest([first]);
    expect((await indexed.getToken(token.mint))?.priceUsd).toBe(100);
    expect((await indexed.searchTokens(token.mint))[0]?.priceUsd).toBe(100);
    expect(await indexed.getExternalToken(token.mint)).toBeNull();
    expect((await indexed.getCandles(token.mint, "1m", 1))[0]?.close).toBe(100);
    expect((await indexed.getRecentTrades(token.mint, 1))[0]?.signature).toBe(first.signature);
    expect((await indexed.getHolders(token.mint, 1)).holders[0]?.wallet).toBe(creator);
  });

  it("serves empty holders for an unlisted live launch but returns 404 for unknown mints", async () => {
    const { sink } = setup();
    const token = launch(newMint(), "solana");
    await sink.ingest([token]);
    const upstream = new LiveMarketDataProvider({
      fetch: async (url) => {
        expect(new URL(url).pathname).toBe("/tokens/v2/search");
        return Response.json([]);
      },
    });
    const indexed = new IndexedMarketDataProvider(db, {
      source: "solana",
      upstream,
      solUsd,
      now: () => time * 1000,
    });
    const app = testApp({ market: indexed, tokens: new TokenService(indexed) });
    expect((await app.request(`/v1/tokens/${token.mint}`)).status).toBe(200);
    const response = await app.request(`/v1/tokens/${token.mint}/holders`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mint: token.mint,
      totalHolders: 0,
      top10Pct: 0,
      holders: [],
      updatedAt: time,
    });
    expect((await app.request(`/v1/tokens/${newMint()}/holders`)).status).toBe(404);
    const unavailable = new AppError(502, "upstream_error", "Upstream unavailable");
    upstream.getHolders = async () => {
      throw unavailable;
    };
    await expect(indexed.getHolders(token.mint, 20)).rejects.toBe(unavailable);
  });

  it("serves the Pulse board and token search routes and validates queries", async () => {
    const { sink, indexed } = setup();
    const token = launch(newMint(), "solana");
    await sink.ingest([token]);
    const app = testApp({ market: indexed, tokens: new TokenService(indexed) });
    const board = await app.request("/v1/pulse?limit=1");
    expect(board.status).toBe(200);
    expect(board.headers.get("X-Data-Source")).toBe("indexed");
    expect(PulseSchema.parse(await board.json()).new).toHaveLength(1);
    expect((await app.request("/v1/pulse?limit=101")).status).toBe(400);
    const search = await app.request(`/v1/tokens/search?q=${token.mint}`);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ tokens: [{ mint: token.mint }] });
    expect((await app.request("/v1/tokens/search?q=%20")).status).toBe(400);
    expect((await app.request(`/v1/tokens/${token.mint}`)).status).toBe(200);
  });
});
