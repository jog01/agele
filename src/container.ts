import { env } from "./config/env";
import { getDb } from "./db/client";
import { PgLeaderboardRepository } from "./repositories/leaderboard.repository";
import { PgPortfolioRepository } from "./repositories/portfolio.repository";
import { PgTradeRepository } from "./repositories/trade.repository";
import { PgUserRepository } from "./repositories/user.repository";
import { type AuthVerifier, createAuthVerifier } from "./services/auth.service";
import { LeaderboardService } from "./services/leaderboard.service";
import { createMarketDataProvider, type MarketDataProvider } from "./services/market-data";
import { PortfolioService } from "./services/portfolio.service";
import { createPrivyUserDirectory, type PrivyUserDirectory } from "./services/privy-user-directory";
import { type LeaderboardStore, RedisLeaderboard } from "./services/social/leaderboard-store";
import { MockSocialProvider } from "./services/social/mock.provider";
import { SocialService } from "./services/social.service";
import { TokenService } from "./services/token.service";
import { TradeIndexer } from "./services/trade-indexer";
import { UserService } from "./services/user.service";
import { RpcWalletBalanceProvider, type WalletBalanceProvider } from "./services/wallet-balance.provider";
import { WsHub } from "./ws/hub";

/** Composition root: wires services so controllers and tests can swap dependencies. */
export interface Container {
  hub: WsHub;
  leaderboardStore: LeaderboardStore;
  leaderboard?: LeaderboardService;
  balances: WalletBalanceProvider;
  portfolio: PortfolioService;
  tradeIndexer: TradeIndexer;
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
  const balances = overrides.balances ?? new RpcWalletBalanceProvider();
  const hub = overrides.hub ?? new WsHub();
  const leaderboardStore = overrides.leaderboardStore ?? new RedisLeaderboard();
  const leaderboard =
    overrides.leaderboard ??
    (env.HELIUS_WEBHOOK_SECRET
      ? new LeaderboardService(new PgLeaderboardRepository(getDb()), leaderboardStore, market, hub)
      : undefined);
  const tradeIndexer = overrides.tradeIndexer ?? new TradeIndexer(new PgTradeRepository(getDb()), market);
  if (leaderboard) tradeIndexer.onTrade((trade) => leaderboard.updateUser(trade.userId));
  const mockSocial = new MockSocialProvider();
  return {
    hub,
    leaderboardStore,
    leaderboard,
    balances,
    portfolio:
      overrides.portfolio ?? new PortfolioService(new PgPortfolioRepository(getDb()), market, balances),
    tradeIndexer,
    privyUsers,
    market,
    auth: overrides.auth ?? createAuthVerifier(),
    tokens,
    social:
      overrides.social ?? new SocialService(mockSocial, tokens, leaderboard ?? mockSocial, !leaderboard),
    users: overrides.users ?? new UserService(new PgUserRepository(getDb()), privyUsers),
  };
}
