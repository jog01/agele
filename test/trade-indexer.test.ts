import { describe, expect, it } from "bun:test";
import type { TradeRepository } from "../src/repositories/trade.repository";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TradeIndexer } from "../src/services/trade-indexer";
import { buy, sell, WALLET } from "./fixtures/helius";

describe("TradeIndexer failure handling", () => {
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
