import { z } from "@hono/zod-openapi";
import { isAddress } from "@solana/kit";

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
export const FeedEventType = z.enum([
  "bought",
  "sold",
  "closed",
  "thesis",
  "milestone",
  "multi-user",
  "new-trader",
]);
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
    discussionKey: z.string().nullable(),
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

const feedEngagement = z.object({
  likeCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  viewerLiked: z.boolean(),
});
const activity = event.extend({
  ...feedEngagement.shape,
  discussionKey: z
    .string()
    .openapi({ description: "Opaque key for this card's comments and reaction routes" }),
});

const DiscussionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trade"), id: z.uuid() }),
  z.object({ kind: z.literal("milestone"), id: z.uuid() }),
  z.object({ kind: z.literal("new-trader"), id: z.uuid() }),
  z.object({
    kind: z.literal("multi-user"),
    mint: z.string().refine(isAddress),
    side: z.enum(["buy", "sell"]),
    bucket: z.int().nonnegative().max(253402300499).multipleOf(300),
  }),
]);
export type FeedDiscussionTarget = z.infer<typeof DiscussionTarget>;
export const FeedDiscussionParam = z.object({
  key: z
    .string()
    .max(100)
    .transform((key, ctx) => {
      const [kind, id, side, bucket, extra] = key.split(":");
      const result = DiscussionTarget.safeParse(
        kind === "multi-user" && extra === undefined && /^(0|[1-9]\d*)$/.test(bucket ?? "")
          ? { kind, mint: id, side, bucket: Number(bucket) }
          : side === undefined && id === id?.toLowerCase()
            ? { kind, id }
            : null,
      );
      if (!result.success) {
        ctx.addIssue({ code: "custom", message: "Invalid feed discussion key" });
        return z.NEVER;
      }
      return { key, target: result.data };
    })
    .openapi({ param: { name: "key", in: "path" }, description: "The card's discussionKey" }),
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
      eventType: z.literal("thesis"),
      marketCapUsd: z.number().nullable(),
      ...engagement.shape,
      ...feedEngagement.shape,
    }),
    activity.extend({
      kind: z.literal("trade"),
      wallet: z.string(),
      side: z.enum(["buy", "sell"]),
      amountUsd: z.number(),
      eventType: z.enum(["bought", "sold", "closed"]),
      tokenAmount: z.number(),
      positionId: z.uuid().nullable(),
      realizedPnlUsd: z.number().nullable(),
      priceSinceFirstBuyPct: z.number().nullable(),
      marketCapUsd: z.number().nullable(),
    }),
    activity.extend({
      kind: z.literal("multi-user"),
      eventType: z.literal("multi-user"),
      wallet: z.string(),
      side: z.enum(["buy", "sell"]),
      amountUsd: z.number(),
      traderCount: z.number().int(),
      marketCapUsd: z.number().nullable(),
    }),
    activity.extend({
      kind: z.literal("milestone"),
      eventType: z.literal("milestone"),
      wallet: z.string(),
      amountUsd: z.number(),
      realizedPnlUsd: z.number(),
      marketCapUsd: z.number().nullable(),
    }),
    activity.extend({
      kind: z.literal("new-trader"),
      eventType: z.literal("new-trader"),
      wallet: z.string(),
      marketCapUsd: z.number().nullable(),
    }),
  ])
  .openapi("FeedItem");

export const FeedQuery = z.object({
  scope: z.enum(["global", "following"]).default("global"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  types: z
    .string()
    .refine((value) => value.split(",").every((type) => FeedEventType.safeParse(type).success))
    .openapi({
      description:
        "Comma-separated eventType values: bought,sold,closed,thesis,milestone,multi-user,new-trader",
    })
    .optional(),
  minSizeUsd: z.coerce.number().nonnegative().optional(),
  minPortfolioUsd: z.coerce.number().nonnegative().optional(),
  minMarketCapUsd: z.coerce.number().nonnegative().optional(),
  maxMarketCapUsd: z.coerce.number().nonnegative().optional(),
  minPriceSinceFirstBuyPct: z.coerce.number().optional(),
  wallet: z.string().refine(isAddress).optional(),
  mint: z.string().refine(isAddress).optional(),
});
export const FeedSchema = z.object({ items: z.array(FeedItemSchema), nextCursor: z.string().nullable() });
export type FeedItemDto = z.infer<typeof FeedItemSchema>;
export type FeedPage = z.infer<typeof FeedSchema>;

export const CommentQuery = FeedQuery.pick({ cursor: true, limit: true });
export const CommentPage = z.object({ comments: z.array(CommentSchema), nextCursor: z.string().nullable() });
export const ThesisThreadSchema = CommentPage.extend({
  id: z.uuid(),
  wallet: z.string(),
  mint: z.string(),
  positionId: z.uuid(),
  pinned: z.union([CommentSchema, z.null()]),
}).openapi("ThesisThread");
