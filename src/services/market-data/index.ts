import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { createChainIngest } from "../chain-ingest";
import { SOL_MINT } from "../helius-parser";
import { IndexedMarketDataProvider } from "./indexed.provider";
import { LiveMarketDataProvider } from "./live.provider";
import { MockMarketDataProvider } from "./mock.provider";

export type { MarketDataProvider } from "./provider";

export function createUpstreamMarketDataProvider() {
  return new LiveMarketDataProvider({
    jupiterApiKey: env.JUPITER_API_KEY,
    birdeyeApiKey: env.BIRDEYE_API_KEY,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    heliusApiKey: env.HELIUS_API_KEY,
  });
}

export function createMarketDataProvider(name = env.MARKET_DATA_PROVIDER) {
  const { solUsd } = createChainIngest(env);
  return new IndexedMarketDataProvider(getDb(), {
    source: env.CHAIN_SOURCE,
    upstream: createUpstreamMarketDataProvider(),
    upstreamTrending: name === "live",
    solUsd,
  });
}

export function createDemoPortfolioMarketDataProvider() {
  const upstream = new MockMarketDataProvider();
  return new IndexedMarketDataProvider(getDb(), {
    source: "demo",
    upstream,
    solUsd: {
      async getSolUsd(time) {
        const price = await upstream.getHistoricalPriceUsd(SOL_MINT, time);
        if (price === null || !Number.isFinite(price) || price <= 0)
          throw new Error("Missing seeded SOL price");
        return price;
      },
    },
  });
}
