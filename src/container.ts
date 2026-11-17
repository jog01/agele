import { env } from "./config/env";
import { getDb } from "./db/client";
import { getRedis } from "./lib/redis";
import { PgSwapRepository } from "./repositories/swap.repository";
import { PgUserRepository } from "./repositories/user.repository";
import { type AuthVerifier, createAuthVerifier } from "./services/auth.service";
import { createMarketDataProvider, type MarketDataProvider } from "./services/market-data";
import { createPrivyUserDirectory, type PrivyUserDirectory } from "./services/privy-user-directory";
import { MockSocialProvider } from "./services/social/mock.provider";
import { SocialService } from "./services/social.service";
import { DisabledFeeSponsor } from "./services/sponsor/disabled-fee-sponsor";
import type { FeeSponsor } from "./services/sponsor/fee-sponsor";
import { TokenService } from "./services/token.service";
import { JupiterSwapClient } from "./services/trading/jupiter-swap.client";
import { SwapService } from "./services/trading/swap.service";
import { RedisSwapRateLimiter, type SwapRateLimiter } from "./services/trading/swap-rate-limiter";
import { UserService } from "./services/user.service";

/** Composition root: wires services so controllers and tests can swap dependencies. */
export interface Container {
  market: MarketDataProvider;
  auth: AuthVerifier;
  tokens: TokenService;
  users: UserService;
  privyUsers: PrivyUserDirectory;
  social: SocialService;
  swaps: SwapService;
  feeSponsor: FeeSponsor;
  swapRateLimiter: SwapRateLimiter;
}

export function createContainer(overrides: Partial<Container> = {}): Container {
  const market = overrides.market ?? createMarketDataProvider();
  const tokens = overrides.tokens ?? new TokenService(market);
  const privyUsers = overrides.privyUsers ?? createPrivyUserDirectory();
  const feeSponsor = env.SPONSOR_ENABLED
    ? (overrides.feeSponsor ?? new DisabledFeeSponsor())
    : new DisabledFeeSponsor();
  return {
    feeSponsor,
    swapRateLimiter: overrides.swapRateLimiter ?? new RedisSwapRateLimiter(getRedis()),
    swaps:
      overrides.swaps ??
      new SwapService(
        new JupiterSwapClient(env.JUPITER_BASE_URL, env.JUPITER_API_KEY),
        feeSponsor,
        new PgSwapRepository(getDb()),
        { maxSlippageBps: env.MAX_SLIPPAGE_BPS, maxPriceImpactPct: env.MAX_PRICE_IMPACT_PCT },
      ),
    privyUsers,
    market,
    auth: overrides.auth ?? createAuthVerifier(),
    tokens,
    social: overrides.social ?? new SocialService(new MockSocialProvider(), tokens),
    users: overrides.users ?? new UserService(new PgUserRepository(getDb()), privyUsers),
  };
}
