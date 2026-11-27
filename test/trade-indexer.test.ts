import { describe, expect, it, spyOn } from "bun:test";
import { env } from "../src/config/env";
import { createTradeIndexProcessor } from "../src/jobs/processors/trade-index";
import { decimal } from "../src/lib/decimal";
import type { IndexedTrade, TradeRepository } from "../src/repositories/trade.repository";
import { SOL_MINT } from "../src/services/helius-parser";
import { createMarketDataProvider, createTradeMarketDataProvider } from "../src/services/market-data";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TradeIndexer } from "../src/services/trade-indexer";
import { buy, MINT, sell, usdtBuy, WALLET } from "./fixtures/helius";

describe("TradeIndexer failure handling", () => {
  it("prices live SOL legs even when SOL is not curated", async () => {
    const allowlist = env.MARKET_TOKEN_ALLOWLIST;
    const birdeyeApiKey = env.BIRDEYE_API_KEY;
    env.MARKET_TOKEN_ALLOWLIST = [];
    env.BIRDEYE_API_KEY = "fixture";
    const stubFetch = async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname === "/defi/v3/ohlcv") {
        expect(url.searchParams.get("address")).toBe(SOL_MINT);
        expect(url.searchParams.get("time_from")).toBe(String(sell.timestamp));
        return Response.json({
          success: true,
          data: { items: [{ unix_time: sell.timestamp, o: 100, h: 200, l: 80, c: 200, v_usd: 1000 }] },
        });
      }
      if (url.pathname === "/tokens/v2/search") {
        return Response.json([{ id: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9 }]);
      }
      expect(url.pathname).toBe("/price/v3");
      expect(url.searchParams.get("ids")).toBe(SOL_MINT);
      return Response.json({ [SOL_MINT]: { usdPrice: 200 } });
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(stubFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      const writes: IndexedTrade[] = [];
      const repository: TradeRepository = {
        reserve: async () => "ready",
        linkedWallets: async () => [{ address: WALLET, userId: "user" }],
        record: async (trade) => {
          writes.push(trade);
          return null;
        },
      };
      const market = createTradeMarketDataProvider();
      const indexer = new TradeIndexer(repository, market);
      await indexer.index([sell, buy]);
      expect(writes.map(({ usd, solPriceUsd }) => [usd, solPriceUsd])).toEqual([
        [decimal("60"), decimal("100")],
        [decimal("100"), undefined],
      ]);
      expect(await market.getToken(SOL_MINT)).toMatchObject({ symbol: "SOL", priceUsd: 200 });
      expect(await createMarketDataProvider("live").getToken(SOL_MINT)).toBeNull();
    } finally {
      env.MARKET_TOKEN_ALLOWLIST = allowlist;
      env.BIRDEYE_API_KEY = birdeyeApiKey;
      fetchSpy.mockRestore();
    }
  });

  it("does not write SOL trades without a usable price", async () => {
    let writes = 0;
    const repository: TradeRepository = {
      reserve: async () => "ready",
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      record: async () => {
        writes++;
        return null;
      },
    };
    const market = new MockMarketDataProvider();
    market.getHistoricalPriceUsd = async () => null;
    const indexer = new TradeIndexer(repository, market);
    await expect(indexer.index([sell])).rejects.toMatchObject({ status: 503, code: "price_unavailable" });
    expect(writes).toBe(0);
  });

  it("retries an unpriced SOL fill without blocking independent stablecoin fills", async () => {
    const writes = new Map<string, IndexedTrade>();
    const pending = new Map<string, string>();
    const repository: TradeRepository = {
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      reserve: async ({ mint, signature }) => {
        if (writes.has(signature)) return "indexed";
        if (!pending.has(mint)) pending.set(mint, signature);
        return pending.get(mint) === signature ? "ready" : "pending";
      },
      record: async (trade) => {
        if (!writes.has(trade.signature)) writes.set(trade.signature, trade);
        pending.delete(trade.mint);
        return null;
      },
    };
    const market = new LiveMarketDataProvider({ allowlist: [] });
    const process = createTradeIndexProcessor(new TradeIndexer(repository, market));
    const stable = (tx: typeof buy, mint: string, offset: number) => ({
      ...tx,
      signature: `${tx.signature}-${offset}`,
      timestamp: sell.timestamp + offset,
      accountData: tx.accountData.map((account) => ({
        ...account,
        tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
          ...change,
          mint: change.mint === MINT ? mint : change.mint,
        })),
      })),
    });
    const dependent = stable(buy, MINT, 1);
    const independentUsdc = stable(buy, "another-token", 2);
    const independentUsdt = stable(usdtBuy, "a-third-token", 3);
    const job = { data: [buy, sell, dependent, independentUsdc, independentUsdt] };
    await expect(process(job)).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
    expect([...writes.keys()]).toEqual([buy.signature, independentUsdc.signature, independentUsdt.signature]);

    market.getHistoricalPriceUsd = async () => 100;
    await process(job);
    expect([...writes.keys()]).toEqual([
      buy.signature,
      independentUsdc.signature,
      independentUsdt.signature,
      sell.signature,
      dependent.signature,
    ]);
    expect(writes.get(sell.signature)?.solPriceUsd).toBe(decimal("100"));
  });

  it("values SOL with the transaction minute, shares lookups within a bucket and ignores spot prices", async () => {
    const writes: IndexedTrade[] = [];
    const repository: TradeRepository = {
      reserve: async () => "ready",
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      record: async (trade) => {
        writes.push(trade);
        return null;
      },
    };
    const market = new MockMarketDataProvider();
    const buckets: number[] = [];
    market.getHistoricalPriceUsd = async (mint, minute) => {
      expect(mint).toBe(SOL_MINT);
      buckets.push(minute);
      return minute === sell.timestamp ? 100 : 200;
    };
    const indexer = new TradeIndexer(repository, market);
    await indexer.index([
      buy,
      { ...sell, timestamp: sell.timestamp + 1 },
      { ...sell, timestamp: sell.timestamp + 59 },
      { ...sell, timestamp: sell.timestamp + 60 },
    ]);
    expect(buckets).toEqual([sell.timestamp, sell.timestamp + 60]);
    expect(writes.map(({ usd, solPriceUsd }) => [usd, solPriceUsd])).toEqual([
      [decimal("100"), undefined],
      [decimal("60"), decimal("100")],
      [decimal("60"), decimal("100")],
      [decimal("120"), decimal("200")],
    ]);
  });

  it("reads only the matching USD candle's open from Birdeye", async () => {
    const minute = sell.timestamp;
    const fill = (unix_time: number, o: number) => ({ unix_time, o, h: 240, l: 80, c: 200, v_usd: 1000 });
    const market = new LiveMarketDataProvider({
      allowlist: [],
      birdeyeApiKey: "fixture",
      fetch: async (input) => {
        const url = new URL(input);
        expect(url.pathname).toBe("/defi/v3/ohlcv");
        expect(url.searchParams.get("address")).toBe(SOL_MINT);
        expect(url.searchParams.get("time_from")).toBe(String(minute));
        expect(url.searchParams.get("time_to")).toBe(String(minute + 60));
        return Response.json({ success: true, data: { items: [fill(minute + 60, 200), fill(minute, 115)] } });
      },
    });
    expect(await market.getHistoricalPriceUsd(SOL_MINT, minute)).toBe(115);
  });
  it("propagates database errors so webhook deliveries can retry", async () => {
    const repository: TradeRepository = {
      reserve: async () => "ready",
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      record: async () => {
        throw new Error("database unavailable");
      },
    };
    const indexer = new TradeIndexer(repository, new MockMarketDataProvider());
    await expect(indexer.index([buy])).rejects.toThrow("database unavailable");
  });
});
