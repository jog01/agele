import { env } from "./config/env";
import { getDb } from "./db/client";
import { type EventPublisher, RedisEventPublisher } from "./events/bus";
import { enqueueTrades, type TradeQueue } from "./jobs/trade-queue";
import { getRedis } from "./lib/redis";
import { type FollowRepository, PgFollowRepository } from "./repositories/follow.repository";
import { PgLeaderboardRepository } from "./repositories/leaderboard.repository";
import { PgPortfolioRepository } from "./repositories/portfolio.repository";
import { PgSwapRepository } from "./repositories/swap.repository";
import { PgTokenActivityRepository } from "./repositories/token-activity.repository";
import { PgTradeRepository } from "./repositories/trade.repository";
import { PgTraderRepository } from "./repositories/trader.repository";
import { PgUserRepository } from "./repositories/user.repository";
import { type AuthVerifier, createAuthVerifier } from "./services/auth.service";
import { LeaderboardService } from "./services/leaderboard.service";
import { createMarketDataProvider, type MarketDataProvider } from "./services/market-data";
import { PortfolioService } from "./services/portfolio.service";
import { createPrivyUserDirectory, type PrivyUserDirectory } from "./services/privy-user-directory";
import { type LeaderboardStore, RedisLeaderboard } from "./services/social/leaderboard-store";
import { MockSocialProvider } from "./services/social/mock.provider";
import { SocialService } from "./services/social.service";
import { DisabledFeeSponsor } from "./services/sponsor/disabled-fee-sponsor";
import type { FeeSponsor } from "./services/sponsor/fee-sponsor";
import { RedisSponsorStore } from "./services/sponsor/issued-store";
import { HttpSponsorRpc } from "./services/sponsor/sponsor-rpc";
import { ValidatedFeeSponsor } from "./services/sponsor/validated-fee-sponsor";
import { TokenService } from "./services/token.service";
import { TokenActivityService } from "./services/token-activity.service";
import { TradeIndexer } from "./services/trade-indexer";
import { TraderService } from "./services/trader.service";
import { JupiterSwapClient } from "./services/trading/jupiter-swap.client";
import { SwapService } from "./services/trading/swap.service";
import { RedisSwapRateLimiter, type SwapRateLimiter } from "./services/trading/swap-rate-limiter";
import { UserService } from "./services/user.service";
import { RpcWalletBalanceProvider, type WalletBalanceProvider } from "./services/wallet-balance.provider";

/** Composition root: wires services so controllers and tests can swap dependencies. */
export interface Container {
  events: EventPublisher;
  tradeQueue: TradeQueue;
  leaderboardStore: LeaderboardStore;
  leaderboard?: LeaderboardService;
  balances: WalletBalanceProvider;
  portfolio: PortfolioService;
  tradeIndexer: TradeIndexer;
  market: MarketDataProvider;
  auth: AuthVerifier;
  tokens: TokenService;
  tokenActivity: TokenActivityService;
  traders: TraderService;
  users: UserService;
  privyUsers: PrivyUserDirectory;
  social: SocialService;
  swaps: SwapService;
  feeSponsor: FeeSponsor;
  swapRateLimiter: SwapRateLimiter;
  follows: FollowRepository;
}

export function createContainer(overrides: Partial<Container> = {}): Container {
  const market = overrides.market ?? createMarketDataProvider();
  const tokens = overrides.tokens ?? new TokenService(market);
  const privyUsers = overrides.privyUsers ?? createPrivyUserDirectory();
  const feeSponsor = env.SPONSOR_ENABLED
    ? (overrides.feeSponsor ??
      (env.FEE_PAYER_PUBKEY && env.FEE_PAYER_SECRET
        ? new ValidatedFeeSponsor({
            enabled: () => env.SPONSOR_ENABLED,
            feePayer: env.FEE_PAYER_PUBKEY,
            secret: env.FEE_PAYER_SECRET,
            rpc: new HttpSponsorRpc(env.SOLANA_RPC_URL),
            store: new RedisSponsorStore(getRedis(), BigInt(Math.floor(env.DAILY_SPEND_CAP_SOL * 1e9))),
            market,
            maxCuPrice: BigInt(env.MAX_CU_PRICE_MICROLAMPORTS),
            maxLamports: BigInt(env.MAX_LAMPORTS_PER_TX),
            referralAccount: env.SPONSOR_REFERRAL_ACCOUNT,
            referralFeeBps: env.SPONSOR_REFERRAL_FEE_BPS,
          })
        : new DisabledFeeSponsor()))
    : new DisabledFeeSponsor();
  const balances = overrides.balances ?? new RpcWalletBalanceProvider();
  const events = overrides.events ?? new RedisEventPublisher();
  const leaderboardStore = overrides.leaderboardStore ?? new RedisLeaderboard();
  const leaderboard =
    overrides.leaderboard ??
    (env.HELIUS_WEBHOOK_SECRET
      ? new LeaderboardService(new PgLeaderboardRepository(getDb()), leaderboardStore, market, events)
      : undefined);
  const tradeIndexer = overrides.tradeIndexer ?? new TradeIndexer(new PgTradeRepository(getDb()), market);
  if (leaderboard) tradeIndexer.onTrade((trade) => leaderboard.updateUser(trade.userId));
  const mockSocial = new MockSocialProvider();
  const follows = overrides.follows ?? new PgFollowRepository(getDb());
  const portfolio =
    overrides.portfolio ?? new PortfolioService(new PgPortfolioRepository(getDb()), market, balances);
  return {
    feeSponsor,
    swapRateLimiter: overrides.swapRateLimiter ?? new RedisSwapRateLimiter(getRedis()),
    swaps:
      overrides.swaps ??
      new SwapService(
        new JupiterSwapClient(env.JUPITER_BASE_URL, env.JUPITER_API_KEY),
        feeSponsor,
        new PgSwapRepository(getDb()),
        {
          maxSlippageBps: env.MAX_SLIPPAGE_BPS,
          maxPriceImpactPct: env.MAX_PRICE_IMPACT_PCT,
          referralAccount: env.SPONSOR_REFERRAL_ACCOUNT,
          referralFee: env.SPONSOR_REFERRAL_FEE_BPS,
        },
      ),
    events,
    tradeQueue: overrides.tradeQueue ?? { enqueue: enqueueTrades },
    leaderboardStore,
    leaderboard,
    balances,
    portfolio,
    traders:
      overrides.traders ??
      new TraderService(
        new PgTraderRepository(getDb()),
        portfolio,
        leaderboard ??
          new LeaderboardService(new PgLeaderboardRepository(getDb()), leaderboardStore, market, events),
        mockSocial,
        follows,
        !!leaderboard,
      ),
    tradeIndexer,
    privyUsers,
    market,
    auth: overrides.auth ?? createAuthVerifier(),
    tokens,
    tokenActivity:
      overrides.tokenActivity ?? new TokenActivityService(new PgTokenActivityRepository(getDb()), market),
    follows,
    social:
      overrides.social ??
      new SocialService(mockSocial, tokens, follows, leaderboard ?? mockSocial, !leaderboard),
    users: overrides.users ?? new UserService(new PgUserRepository(getDb()), privyUsers),
  };
}
