import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { createChainIngest } from "../chain-ingest";
import { IndexedMarketDataProvider } from "./indexed.provider";
import { LiveMarketDataProvider } from "./live.provider";

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
