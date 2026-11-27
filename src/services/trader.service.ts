import { notFound } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { PgTraderRepository } from "../repositories/trader.repository";
import type { LeaderboardService } from "./leaderboard.service";
import type { PortfolioService } from "./portfolio.service";

export class TraderService {
  constructor(
    private readonly repository: PgTraderRepository,
    private readonly portfolio: PortfolioService,
    private readonly leaderboard: LeaderboardService,
    private readonly follows: FollowRepository,
    private readonly ranks: boolean | "database",
  ) {}

  private async resolve(wallet: string) {
    const user = await this.repository.findByWallet(wallet);
    if (!user) throw notFound("Trader");
    return user;
  }

  async profile(wallet: string, viewerId?: string) {
    const user = await this.resolve(wallet);
    const addresses = [
      ...new Set([
        wallet,
        ...(user.walletAddress ? [user.walletAddress] : []),
        ...(await this.repository.linkedAddresses(user.id)),
      ]),
    ];
    const [summary, stats, followers, following, followed] = await Promise.all([
      this.portfolio.getPositionSummary(user.id),
      this.leaderboard.userStats(user.id, this.ranks),
      this.repository.followerCount(addresses),
      this.repository.followingCount(user.id),
      viewerId ? this.follows.listWallets(viewerId) : undefined,
    ]);
    const canonical = user.walletAddress ?? wallet;
    return {
      source: user.demo ? "demo" : "indexed",
      profile: {
        wallet: canonical,
        handle: user.handle ?? canonical.slice(0, 8),
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        followers,
        following,
        ...(followed ? { isFollowing: addresses.some((address) => followed.includes(address)) } : {}),
        ...summary,
        stats,
      },
    };
  }

  async trades(wallet: string, limit: number, cursor?: string) {
    const user = await this.resolve(wallet);
    return {
      source: user.demo ? "demo" : "indexed",
      page: await this.portfolio.getTrades(user.id, limit, cursor),
    };
  }
}
