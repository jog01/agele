import { env } from "../../config/env";
import { MockMarketDataProvider } from "./mock.provider";
import type { MarketDataProvider } from "./provider";

export type { MarketDataProvider } from "./provider";

export function createMarketDataProvider(name = env.MARKET_DATA_PROVIDER): MarketDataProvider {
  switch (name) {
    case "mock":
      return new MockMarketDataProvider();
  }
}
