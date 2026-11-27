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
    source: z.literal("demo").optional(),
    isFollowing: z.boolean().optional(),
  })
  .openapi("LeaderboardEntry");

const Position = z.enum(["long", "short", "none"]);
const Source = z.enum(["demo", "indexed"]);
const author = z.object({
  handle: z.string(),
  avatarUrl: z.string().nullable(),
  source: Source,
});
const event = author.extend({
  id: z.uuid(),
  mint: z.string(),
  symbol: z.string(),
  imageUrl: z.string().nullable(),
  position: Position,
  createdAt: z.number().int().openapi({ description: "Unix seconds" }),
});
const engagement = z.object({
  likes: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  likedByMe: z.boolean().optional(),
});

export const CommentSchema = event
  .extend({
    kind: z.enum(["thesis", "comment"]),
    wallet: z.string().nullable(),
    thesisId: z.uuid().nullable(),
    parentId: z.uuid().nullable(),
    pinned: z.boolean(),
    body: z.string(),
    ...engagement.shape,
  })
  .openapi("Comment");

export const SocialPostBody = z.object({
  body: z.string().trim().min(1).max(3_000),
  position: Position.default("none"),
  positionId: z.uuid().optional(),
});

export const CommentBody = SocialPostBody.omit({ positionId: true }).extend({
  body: z.string().trim().min(1).max(200),
  parentId: z.uuid().optional(),
});

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
    event.extend({
      kind: z.literal("thesis"),
      wallet: z.string(),
      body: z.string(),
      thesisId: z.uuid(),
      positionId: z.uuid(),
      pinned: z.boolean(),
      ...engagement.shape,
    }),
    event.extend({
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

export const CommentQuery = FeedQuery.omit({ scope: true });
export const CommentPage = z.object({ comments: z.array(CommentSchema), nextCursor: z.string().nullable() });
export const ThesisThreadSchema = CommentPage.extend({
  id: z.uuid(),
  wallet: z.string(),
  mint: z.string(),
  positionId: z.uuid(),
  pinned: z.union([CommentSchema, z.null()]),
}).openapi("ThesisThread");
