import type { z } from "@hono/zod-openapi";
import { divide, formatDecimal } from "../lib/decimal";
import { notFound, unauthorized } from "../lib/errors";
import type { Trade } from "../models";
import type { FollowRepository } from "../repositories/follow.repository";
import type {
  PgTokenActivityRepository,
  TokenHolderUserRow,
} from "../repositories/token-activity.repository";
import type { TokenHolderListSchema, TokenHoldersQuery } from "../schemas/token-activity";
import type { MarketDataProvider } from "./market-data";
import { cachePositionQuotes, type PositionQuote } from "./market-data/position-quotes";
import { positionEpisodes, weightedCap } from "./position-episodes";

type HolderList = z.infer<typeof TokenHolderListSchema>;
type Holder = HolderList["holders"][number];
type HolderOptions = z.output<typeof TokenHoldersQuery>;

export const TRADER_HOLDER_CAP = 200;
const unix = (date: Date) => Math.floor(date.getTime() / 1000);
const number = (value: bigint) => Number(formatDecimal(value));
const validPrice = (price: number | undefined) =>
  price !== undefined && Number.isFinite(price) && price > 0 ? price : null;

export class TokenHoldersService {
  constructor(
    private readonly repository: PgTokenActivityRepository,
    private readonly market: MarketDataProvider,
    private readonly follows: FollowRepository,
    private readonly positionQuote: PositionQuote,
  ) {}

  async list(mint: string, options: HolderOptions, viewerId?: string): Promise<HolderList> {
    if (options.followingOnly && !viewerId) throw unauthorized("Sign in to filter holders you follow");
    const token = await this.market.getToken(mint);
    if (!token) throw notFound("Token");
    const [snapshot, followed] = await Promise.all([
      this.market.getHolders(mint, 50),
      viewerId ? this.follows.listWallets(viewerId) : Promise.resolve(undefined),
    ]);
    const followedSet = new Set(followed ?? []);
    const users =
      options.scope === "all"
        ? await this.repository.holderUsers(mint, {
            wallets: snapshot.holders.map((holder) => holder.wallet),
          })
        : await this.repository.holderUsers(mint, { holding: true, limit: TRADER_HOLDER_CAP });
    const quote = cachePositionQuotes(this.positionQuote);
    const enrich = await this.enricher(mint, users, quote);
    const reference = snapshot.holders.find((holder) => holder.pctSupply > 0);
    const supply = reference
      ? (100 * reference.amount) / reference.pctSupply
      : validPrice(token.priceUsd)
        ? token.marketCapUsd / token.priceUsd
        : 0;

    const rows: Holder[] =
      options.scope === "all"
        ? snapshot.holders.map((holder) => {
            const user = users.find((row) => row.addresses.includes(holder.wallet));
            const social = enrich(user);
            return {
              ...holder,
              ...social,
              isFollowed: followedSet.has(holder.wallet) || social.addresses.some((a) => followedSet.has(a)),
            };
          })
        : await Promise.all(
            users.map(async (user, index) => {
              const social = enrich(user);
              const amount = Number(user.quantity);
              const price = validPrice((await quote(mint, user.seeded))?.priceUsd) ?? social.avgCost;
              return {
                rank: index + 1,
                wallet: user.wallet ?? user.addresses[0] ?? "",
                amount,
                pctSupply: supply > 0 ? (100 * amount) / supply : 0,
                valueUsd: amount * price,
                ...social,
                isFollowed: social.addresses.some((a) => followedSet.has(a)),
              };
            }),
          );

    const holders = rows
      .filter(
        (row) =>
          (!options.thesisOnly || row.latestThesis) &&
          (!options.followingOnly || row.isFollowed) &&
          row.valueUsd >= options.minValueUsd,
      )
      .slice(0, options.limit)
      .map(
        ({
          addresses: _addresses,
          avgCost: _avgCost,
          ...row
        }: Holder & { addresses?: string[]; avgCost?: number }) => row,
      );

    return {
      mint,
      scope: options.scope,
      totalHolders: snapshot.totalHolders,
      top10Pct: snapshot.top10Pct,
      holders,
      updatedAt: snapshot.updatedAt,
    };
  }

  private async enricher(mint: string, users: TokenHolderUserRow[], quote: PositionQuote) {
    const fills = await this.repository.tradesFor(users.map((user) => user.userId));
    const byUser = new Map<string, Trade[]>();
    for (const fill of fills) byUser.set(fill.userId, [...(byUser.get(fill.userId) ?? []), fill]);
    const prices = new Map<boolean, number | null>();
    for (const seeded of new Set(users.map((user) => user.seeded))) {
      prices.set(seeded, validPrice((await quote(mint, seeded))?.priceUsd));
    }

    return (user: TokenHolderUserRow | undefined) => {
      if (!user)
        return { trader: null, position: null, latestThesis: null, addresses: [] as string[], avgCost: 0 };
      const episodes = positionEpisodes(byUser.get(user.userId) ?? []);
      const closed = episodes.filter((episode) => episode.closedAt);
      const avgHoldSeconds = closed.length
        ? Math.round(
            closed.reduce((sum, episode) => sum + unix(episode.closedAt!) - unix(episode.openedAt), 0) /
              closed.length,
          )
        : null;
      const open = episodes.findLast((episode) => episode.mint === mint && !episode.closedAt);
      const price = prices.get(user.seeded) ?? null;
      const avgCost = open && open.quantity > 0n ? number(divide(open.costBasis, open.quantity)) : 0;
      let position: Holder["position"] = null;
      if (open) {
        const invested = number(open.invested);
        const realized = number(open.realizedPnl);
        const unrealized = price === null ? 0 : number(open.quantity) * price - number(open.costBasis);
        const pnl = realized + unrealized;
        position = {
          positionId: open.id,
          firstBoughtAt: unix(open.openedAt),
          investedUsd: invested,
          avgEntryMarketCapUsd: weightedCap(open.fills, "buy"),
          realizedPnlUsd: realized,
          unrealizedPnlUsd: unrealized,
          pnlUsd: pnl,
          pnlPct: invested > 0 ? (100 * pnl) / invested : 0,
        };
      }
      return {
        trader: {
          wallet: user.wallet,
          handle: user.handle,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          avgHoldSeconds,
          source: user.seeded ? ("demo" as const) : ("indexed" as const),
        },
        position,
        latestThesis:
          user.thesisId && user.postId
            ? {
                thesisId: user.thesisId,
                postId: user.postId,
                positionId: user.thesisPositionId!,
                body: user.body ?? "",
                createdAt: user.thesisCreatedAt ?? 0,
                likeCount: user.likeCount ?? 0,
                replyCount: user.replyCount ?? 0,
                viewCount: user.viewCount ?? 0,
              }
            : null,
        addresses: user.addresses,
        avgCost,
      };
    };
  }
}
