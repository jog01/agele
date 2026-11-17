import { notFound } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { PgTraderRepository } from "../repositories/trader.repository";
import type { LeaderboardService } from "./leaderboard.service";
import { decodeTradeCursor, type PortfolioService } from "./portfolio.service";
import type { MockSocialProvider } from "./social/mock.provider";

export class TraderService {
  constructor(
    private readonly repository: PgTraderRepository,
    private readonly portfolio: PortfolioService,
    private readonly leaderboard: LeaderboardService,
    private readonly mock: MockSocialProvider,
    private readonly follows: FollowRepository,
    private readonly indexedRanks: boolean,
  ) {}

  private async resolve(wallet: string) {
    const user = await this.repository.findByWallet(wallet);
    if (user) return { user };
    const demo = (await this.mock.leaderboard("24h", 100)).find((row) => row.wallet === wallet);
    if (!demo) throw notFound("Trader");
    return { demo };
  }

  async profile(wallet: string, viewerId?: string) {
    const trader = await this.resolve(wallet);
    if (trader.user) {
      const user = trader.user;
      const addresses = [
        ...new Set([
          wallet,
          ...(user.walletAddress ? [user.walletAddress] : []),
          ...(await this.repository.linkedAddresses(user.id)),
        ]),
      ];
      const [summary, stats, followers, following, followed] = await Promise.all([
        this.portfolio.getPositionSummary(user.id),
        this.leaderboard.userStats(user.id, this.indexedRanks),
        this.repository.followerCount(addresses),
        this.repository.followingCount(user.id),
        viewerId ? this.follows.listWallets(viewerId) : undefined,
      ]);
      const canonical = user.walletAddress ?? wallet;
      return {
        source: "indexed" as const,
        profile: {
          wallet: canonical,
          handle: user.handle ?? canonical.slice(0, 8),
          avatarUrl: user.avatarUrl,
          followers,
          following,
          ...(followed ? { isFollowing: addresses.some((address) => followed.includes(address)) } : {}),
          ...summary,
          stats,
        },
      };
    }
    const [day, week, month, followers, followed] = await Promise.all([
      Promise.resolve(trader.demo),
      this.mock.leaderboard("7d", 100).then((rows) => rows.find((row) => row.wallet === wallet)!),
      this.mock.leaderboard("30d", 100).then((rows) => rows.find((row) => row.wallet === wallet)!),
      this.repository.followerCount([wallet]),
      viewerId ? this.follows.listWallets(viewerId) : undefined,
    ]);
    const stats = (row: typeof day) => ({
      pnlUsd: row.pnlUsd,
      pnlPct: row.pnlPct,
      volumeUsd: row.volumeUsd,
      trades: row.trades,
      winRatePct: row.winRatePct,
      rank: row.rank,
    });
    return {
      source: "demo" as const,
      profile: {
        wallet,
        handle: day.handle,
        avatarUrl: null,
        followers,
        following: 0,
        ...(followed ? { isFollowing: followed.includes(wallet) } : {}),
        realizedPnlUsd: month.pnlUsd,
        unrealizedPnlUsd: 0,
        positions: [],
        stats: { "24h": stats(day), "7d": stats(week), "30d": stats(month) },
      },
    };
  }

  async trades(wallet: string, limit: number, cursor?: string) {
    const trader = await this.resolve(wallet);
    if (trader.user)
      return {
        source: "indexed" as const,
        page: await this.portfolio.getTrades(trader.user.id, limit, cursor),
      };
    if (cursor !== undefined) decodeTradeCursor(cursor);
    return { source: "demo" as const, page: { trades: [], nextCursor: null } };
  }
}
