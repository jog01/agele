import { z } from "@hono/zod-openapi";
import { PortfolioHistorySchema, UserTradeSchema } from "./portfolio";
import { LeaderboardEntrySchema, MostLikedThesisSchema } from "./social";
import { TokenPositionSchema } from "./token-activity";

export const TraderParam = z.object({ wallet: z.string().min(32).max(44) });
const stats = LeaderboardEntrySchema.omit({
  wallet: true,
  handle: true,
  isFollowing: true,
  rank: true,
  source: true,
})
  .extend({ rank: z.number().int().positive().nullable() })
  .openapi("TraderWindowStats");
const TopTradeSchema = z.object({
  positionId: z.uuid(),
  mint: z.string(),
  symbol: z.string(),
  imageUrl: z.string().nullable(),
  closedAt: z.number().int(),
  realizedPnlUsd: z.number(),
  realizedPnlPct: z.number(),
});
const PositionFillSchema = UserTradeSchema.extend({ marketCapUsd: z.number().nullable() });
export const TraderProfileSchema = z
  .object({
    wallet: z.string(),
    handle: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    bio: z.string().nullable(),
    joinedAt: z.number().int(),
    tradeCount: z.number().int().nonnegative(),
    avgHoldSeconds: z.number().int().nonnegative().nullable(),
    mutuals: z
      .object({
        count: z.number().int().nonnegative(),
        preview: z.array(z.object({ wallet: z.string().nullable(), avatarUrl: z.string().nullable() })),
      })
      .optional(),
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
    isFollowing: z.boolean().optional(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    stats: z.object({ "24h": stats, "7d": stats, "30d": stats }),
    positions: z.array(TokenPositionSchema.extend({ imageUrl: z.string().nullable() })),
    topTrades: z.array(TopTradeSchema).max(5),
    mostLikedThesis: MostLikedThesisSchema.nullable(),
  })
  .openapi("TraderProfile");

export const TraderPositionSchema = z
  .object({
    id: z.uuid(),
    wallet: z.string(),
    mint: z.string(),
    symbol: z.string(),
    imageUrl: z.string().nullable(),
    openedAt: z.number().int(),
    closedAt: z.number().int().nullable(),
    quantity: z.number(),
    avgEntryUsd: z.number(),
    avgEntryMarketCapUsd: z.number().nullable(),
    avgExitMarketCapUsd: z.number().nullable(),
    totalInvestedUsd: z.number(),
    pnlPct: z.number(),
    avgCostUsd: z.number(),
    priceUsd: z.number(),
    priceSinceFirstBuyPct: z.number().nullable(),
    valueUsd: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    fills: z.array(PositionFillSchema),
  })
  .openapi("TraderPosition");

export const PositionTransactionsQuery = z.object({
  positionId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  minSizeUsd: z.coerce.number().finite().nonnegative().optional(),
});
export const PositionTransactionsSchema = z
  .object({
    positionId: z.uuid(),
    total: z.number().int().nonnegative(),
    totalInvestedUsd: z.number(),
    nextPage: z.number().int().nullable(),
    transactions: z.array(PositionFillSchema),
  })
  .openapi("PositionTransactions");

export const TraderConnectionsSchema = z
  .object({
    users: z.array(
      z.object({
        wallet: z.string().nullable(),
        handle: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        createdAt: z.number().int(),
        isFollowing: z.boolean().optional(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi("TraderConnections");

export const PublicPortfolioHistorySchema = PortfolioHistorySchema.extend({
  changeUsd: z.number().nullable().optional(),
  changePct: z.number().nullable().optional(),
}).openapi("PublicPortfolioHistory");
