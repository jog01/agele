import { getDb } from "./db/client";
import { PgUserRepository } from "./repositories/user.repository";
import { type AuthVerifier, createAuthVerifier } from "./services/auth.service";
import { createMarketDataProvider, type MarketDataProvider } from "./services/market-data";
import { createPrivyUserDirectory, type PrivyUserDirectory } from "./services/privy-user-directory";
import { MockSocialProvider } from "./services/social/mock.provider";
import { SocialService } from "./services/social.service";
import { TokenService } from "./services/token.service";
import { UserService } from "./services/user.service";

/** Composition root: wires services so controllers and tests can swap dependencies. */
export interface Container {
  market: MarketDataProvider;
  auth: AuthVerifier;
  tokens: TokenService;
  users: UserService;
  privyUsers: PrivyUserDirectory;
  social: SocialService;
}

export function createContainer(overrides: Partial<Container> = {}): Container {
  const market = overrides.market ?? createMarketDataProvider();
  const tokens = overrides.tokens ?? new TokenService(market);
  const privyUsers = overrides.privyUsers ?? createPrivyUserDirectory();
  return {
    privyUsers,
    market,
    auth: overrides.auth ?? createAuthVerifier(),
    tokens,
    social: overrides.social ?? new SocialService(new MockSocialProvider(), tokens),
    users: overrides.users ?? new UserService(new PgUserRepository(getDb()), privyUsers),
  };
}
