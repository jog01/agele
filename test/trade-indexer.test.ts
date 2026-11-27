import { describe, expect, it, spyOn } from "bun:test";
import { env } from "../src/config/env";
import { decimal } from "../src/lib/decimal";
import type { IndexedTrade, TradeRepository } from "../src/repositories/trade.repository";
import { SOL_MINT } from "../src/services/helius-parser";
import { createMarketDataProvider, createTradeMarketDataProvider } from "../src/services/market-data";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TradeIndexer } from "../src/services/trade-indexer";
import { buy, sell, WALLET } from "./fixtures/helius";

describe("TradeIndexer failure handling", () => {
  it("prices live SOL legs even when SOL is not curated", async () => {
    const allowlist = env.MARKET_TOKEN_ALLOWLIST;
    env.MARKET_TOKEN_ALLOWLIST = [];
    const stubFetch = async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.pathname === "/tokens/v2/search") {
        return Response.json([{ id: SOL_MINT, symbol: "SOL", name: "Solana", decimals: 9 }]);
      }
      expect(url.pathname).toBe("/price/v3");
      expect(url.searchParams.get("ids")).toBe(SOL_MINT);
      return Response.json({ [SOL_MINT]: { usdPrice: 100 } });
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(stubFetch, { preconnect: globalThis.fetch.preconnect }),
    );
    try {
      const writes: IndexedTrade[] = [];
      const repository: TradeRepository = {
        linkedWallets: async () => [{ address: WALLET, userId: "user" }],
        record: async (trade) => {
          writes.push(trade);
          return null;
        },
      };
      const indexer = new TradeIndexer(repository, createTradeMarketDataProvider());
      await indexer.index([sell, buy]);
      expect(writes.map((trade) => trade.usd)).toEqual([decimal("60"), decimal("100")]);
      expect(await createMarketDataProvider("live").getToken(SOL_MINT)).toBeNull();
    } finally {
      env.MARKET_TOKEN_ALLOWLIST = allowlist;
      fetchSpy.mockRestore();
    }
  });

  it("does not write SOL trades without a usable price", async () => {
    let writes = 0;
    const repository: TradeRepository = {
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      record: async () => {
        writes++;
        return null;
      },
    };
    const market = new MockMarketDataProvider();
    market.getToken = async () => null;
    const indexer = new TradeIndexer(repository, market);
    await expect(indexer.index([sell])).rejects.toMatchObject({ status: 503, code: "price_unavailable" });
    expect(writes).toBe(0);
  });
  it("propagates database errors so webhook deliveries can retry", async () => {
    const repository: TradeRepository = {
      linkedWallets: async () => [{ address: WALLET, userId: "user" }],
      record: async () => {
        throw new Error("database unavailable");
      },
    };
    const indexer = new TradeIndexer(repository, new MockMarketDataProvider());
    await expect(indexer.index([buy])).rejects.toThrow("database unavailable");
  });
});
