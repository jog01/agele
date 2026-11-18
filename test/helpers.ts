import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TokenService } from "../src/services/token.service";

export const FIXED_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const SOL = "So11111111111111111111111111111111111111112";

export function testApp(overrides: Partial<Container> = {}) {
  const market = new MockMarketDataProvider(() => FIXED_NOW);
  const container = createContainer({
    events: { publish() {} },
    market,
    tokens: new TokenService(market),
    follows: new InMemoryFollowRepository(),
    ...overrides,
  });
  return createApp(container);
}
