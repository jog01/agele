import { env } from "../../config/env";
import { LiveMarketDataProvider } from "./live.provider";
import { MockMarketDataProvider } from "./mock.provider";
import type { MarketDataProvider } from "./provider";

export type { MarketDataProvider } from "./provider";

export function createMarketDataProvider(name = env.MARKET_DATA_PROVIDER): MarketDataProvider {
  switch (name) {
    case "live":
      return new LiveMarketDataProvider({
        allowlist: env.MARKET_TOKEN_ALLOWLIST,
        jupiterApiKey: env.JUPITER_API_KEY,
        birdeyeApiKey: env.BIRDEYE_API_KEY,
        solanaRpcUrl: env.SOLANA_RPC_URL,
        heliusApiKey: env.HELIUS_API_KEY,
      });
    case "mock":
      return new MockMarketDataProvider();
  }
}
