import { z } from "@hono/zod-openapi";

export const LeaderboardWindow = z.enum(["24h", "7d", "30d"]);

export const LeaderboardEntrySchema = z
  .object({
    rank: z.number().int(),
    wallet: z.string(),
    handle: z.string(),
    pnlUsd: z.number(),
    pnlPct: z.number(),
    volumeUsd: z.number(),
    trades: z.number().int(),
    winRatePct: z.number(),
    isFollowing: z.boolean().optional(),
  })
  .openapi("LeaderboardEntry");

export const CommentSchema = z
  .object({
    id: z.string(),
    mint: z.string(),
    handle: z.string(),
    body: z.string(),
    position: z.enum(["long", "short", "none"]),
    likes: z.number().int(),
    createdAt: z.number().int().openapi({ description: "Unix seconds" }),
  })
  .openapi("Comment");

export const LeaderboardQuery = z.object({
  window: LeaderboardWindow.default("24h").openapi({ param: { name: "window", in: "query" } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .openapi({ param: { name: "limit", in: "query" } }),
});

export type LeaderboardWindowValue = z.infer<typeof LeaderboardWindow>;
export type LeaderboardEntryDto = z.infer<typeof LeaderboardEntrySchema>;
export type CommentDto = z.infer<typeof CommentSchema>;

export const FeedItemSchema = z
  .discriminatedUnion("kind", [
    CommentSchema.omit({ likes: true }).extend({ kind: z.literal("thesis"), wallet: z.string() }),
    CommentSchema.omit({ likes: true, body: true }).extend({
      kind: z.literal("trade"),
      wallet: z.string(),
      side: z.enum(["buy", "sell"]),
      amountUsd: z.number(),
    }),
  ])
  .openapi("FeedItem");

export const FeedQuery = z.object({
  scope: z.enum(["global", "following"]).default("global"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const FeedSchema = z.object({ items: z.array(FeedItemSchema), nextCursor: z.string().nullable() });
export type FeedItemDto = z.infer<typeof FeedItemSchema>;
export type FeedPage = z.infer<typeof FeedSchema>;
