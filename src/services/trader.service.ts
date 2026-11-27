import { isAddress } from "@solana/kit";
import { divide, formatDecimal } from "../lib/decimal";
import { badRequest, notFound } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { PgTraderRepository } from "../repositories/trader.repository";
import type { LeaderboardService } from "./leaderboard.service";
import type { MarketDataProvider } from "./market-data";
import { optionalQuote, type PositionQuote } from "./market-data/position-quotes";
import type { PortfolioService } from "./portfolio.service";
import { positionEpisodes } from "./position-episodes";
import { decodeCursor, encodeCursor } from "./social/cursor";

const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const number = (value: bigint) => Number(formatDecimal(value));

export class TraderService {
  constructor(
    private readonly repository: PgTraderRepository,
    private readonly portfolio: PortfolioService,
    private readonly leaderboard: LeaderboardService,
    private readonly follows: FollowRepository,
    private readonly ranks: boolean | "database",
    market: MarketDataProvider,
    private readonly positionQuote: PositionQuote = (mint) => market.getToken(mint),
  ) {}

  private async resolve(wallet: string) {
    const user = await this.repository.findByWallet(wallet);
    if (!user) throw notFound("Trader");
    return user;
  }

  private async allAddresses(userId: string, wallet: string, primary: string | null) {
    return [
      ...new Set([wallet, ...(primary ? [primary] : []), ...(await this.repository.linkedAddresses(userId))]),
    ];
  }

  async profile(wallet: string, viewerId?: string) {
    const user = await this.resolve(wallet);
    const addresses = await this.allAddresses(user.id, wallet, user.walletAddress);
    const [summary, stats, followers, following, followed, fills] = await Promise.all([
      this.portfolio.getPositionSummary(user.id),
      this.leaderboard.userStats(user.id, this.ranks),
      this.repository.followerCount(addresses),
      this.repository.followingCount(user.id),
      viewerId ? this.follows.listWallets(viewerId) : undefined,
      this.repository.tradeHistory(user.id),
    ]);
    const closed = positionEpisodes(fills).filter((episode) => episode.closedAt);
    const avgHoldSeconds = closed.length
      ? Math.round(
          closed.reduce((sum, episode) => sum + unix(episode.closedAt!) - unix(episode.openedAt), 0) /
            closed.length,
        )
      : null;
    const mutuals = followed ? await this.repository.mutualFollowers(addresses, followed) : undefined;
    const canonical = user.walletAddress ?? wallet;
    return {
      source: user.demo ? "demo" : "indexed",
      profile: {
        wallet: canonical,
        handle: user.handle ?? canonical.slice(0, 8),
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        bio: user.bio,
        joinedAt: unix(user.createdAt),
        tradeCount: fills.length,
        avgHoldSeconds,
        ...(mutuals ? { mutuals } : {}),
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

  async position(wallet: string, mint: string, positionId?: string) {
    const user = await this.resolve(wallet);
    const [fills, token] = await Promise.all([
      this.repository.tradeHistory(user.id, mint),
      this.repository.token(mint),
    ]);
    const episodes = positionEpisodes(fills);
    const episode = positionId ? episodes.find((item) => item.id === positionId) : episodes.at(-1);
    if (!episode || !token) throw notFound("Position");
    const market = episode.closedAt ? null : await optionalQuote(() => this.positionQuote(mint, user.demo));
    const remaining = number(episode.quantity);
    const entry = number(divide(episode.invested, episode.bought));
    const avgCost = episode.quantity ? number(divide(episode.costBasis, episode.quantity)) : entry;
    const lastFill = episode.fills.at(-1)!;
    const marketPrice = market?.priceUsd && market.priceUsd > 0 ? market.priceUsd : null;
    const availablePrice = episode.closedAt ? Number(lastFill.priceUsd) : marketPrice;
    const price = availablePrice ?? avgCost;
    const firstBuyPrice = Number(episode.fills[0]!.priceUsd);
    return {
      source: user.demo ? "demo" : "indexed",
      position: {
        id: episode.id,
        wallet: user.walletAddress ?? wallet,
        mint,
        symbol: token.symbol,
        imageUrl: token.imageUrl,
        openedAt: unix(episode.openedAt),
        closedAt: episode.closedAt ? unix(episode.closedAt) : null,
        quantity: remaining,
        avgEntryUsd: entry,
        avgCostUsd: avgCost,
        priceUsd: price,
        priceSinceFirstBuyPct:
          firstBuyPrice > 0 && availablePrice !== null ? (availablePrice / firstBuyPrice - 1) * 100 : null,
        valueUsd: remaining * price,
        realizedPnlUsd: number(episode.realizedPnl),
        unrealizedPnlUsd: availablePrice === null ? 0 : remaining * price - number(episode.costBasis),
        fills: episode.fills.map((fill) => ({
          id: fill.id,
          signature: fill.signature,
          mint,
          symbol: token.symbol,
          imageUrl: token.imageUrl,
          side: fill.side,
          tokenAmount: Number(fill.tokenAmount),
          priceUsd: Number(fill.priceUsd),
          valueUsd: Number(fill.quoteAmountUsd),
          realizedPnlUsd:
            fill.side === "sell" && fill.realizedPnlUsd !== null ? Number(fill.realizedPnlUsd) : null,
          time: unix(fill.executedAt),
        })),
      },
    };
  }

  async connections(
    wallet: string,
    direction: "followers" | "following",
    limit: number,
    after?: string,
    viewerId?: string,
  ) {
    const user = await this.resolve(wallet);
    const cursor = after === undefined ? undefined : decodeCursor(after);
    if (
      cursor &&
      (direction === "followers"
        ? !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cursor.id)
        : !isAddress(cursor.id))
    ) {
      throw badRequest("Invalid connection cursor");
    }
    const followed = viewerId ? await this.follows.listWallets(viewerId) : undefined;
    const rows =
      direction === "followers"
        ? await this.repository.followers(
            await this.allAddresses(user.id, wallet, user.walletAddress),
            followed,
            limit + 1,
            cursor,
          )
        : await this.repository.following(user.id, followed, limit + 1, cursor);
    return {
      source: user.demo ? "demo" : "indexed",
      page: {
        users: rows.slice(0, limit).map(({ id: _, isFollowing, ...row }) => ({
          ...row,
          ...(viewerId ? { isFollowing: isFollowing ?? false } : {}),
        })),
        nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]!) : null,
      },
    };
  }

  async portfolioHistory(wallet: string, range: "24h" | "7d" | "30d" | "all") {
    const user = await this.resolve(wallet);
    return {
      source: user.demo ? "demo" : "indexed",
      history: await this.portfolio.getPublicPositionsHistory(user.id, range),
    };
  }
}
