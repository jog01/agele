import { z } from "@hono/zod-openapi";
import { LeaderboardWindow } from "./social";

export const NotificationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(256).optional(),
});

export const AlertSettingsSchema = z
  .object({ traderActivity: z.boolean(), sound: z.boolean() })
  .openapi("AlertSettings");

const actor = z.object({
  wallet: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

const base = z.object({
  id: z.string().describe("Stable notification or group ID"),
  createdAt: z.number().describe("Unix seconds; time of the latest event in the group"),
  readAt: z.number().nullable().describe("Unix seconds, or null if any event in this item is unread"),
  actors: z.array(actor).max(3),
  actorCount: z.number().int().nonnegative(),
});

const token = z.object({ mint: z.string(), symbol: z.string(), imageUrl: z.string().nullable() });
const thesisTarget = z.object({
  wallet: z.string(),
  positionId: z.uuid(),
  thesisId: z.uuid(),
  commentId: z.uuid(),
});
const tradeTarget = z.object({
  wallet: z.string(),
  positionId: z.uuid().nullable(),
  sizeUsd: z.number().nonnegative(),
  side: z.enum(["buy", "sell"]),
});
const leaderboardTarget = z.object({
  window: LeaderboardWindow,
  rank: z.number().int().positive(),
  previousRank: z.number().int().positive().nullable(),
});

const thesisLike = base.extend({ kind: z.literal("thesis_like"), target: thesisTarget.extend(token.shape) });
const thesisComment = base.extend({
  kind: z.literal("thesis_comment"),
  target: thesisTarget.extend(token.shape),
});
const trade = base.extend({ kind: z.literal("trader_trade"), target: tradeTarget.extend(token.shape) });
const follow = base.extend({
  kind: z.literal("follow"),
  target: z.object({ wallet: z.string().nullable() }),
});
const leaderboard = base.extend({ kind: z.literal("leaderboard"), target: leaderboardTarget });

export const NotificationSchema = z
  .discriminatedUnion("kind", [trade, thesisLike, thesisComment, follow, leaderboard])
  .openapi("Notification");

export type NotificationDetails =
  | { kind: "trader_trade"; target: z.infer<typeof tradeTarget> }
  | { kind: "thesis_like"; target: z.infer<typeof thesisTarget> }
  | { kind: "thesis_comment"; target: z.infer<typeof thesisTarget> }
  | { kind: "follow" }
  | { kind: "leaderboard"; target: z.infer<typeof leaderboardTarget> };

export const UnreadCountSchema = z
  .object({ unreadCount: z.number().int().nonnegative() })
  .openapi("NotificationUnreadCount");

export const NotificationPageSchema = z
  .object({
    items: z.array(NotificationSchema),
    nextCursor: z.string().nullable(),
    source: z.enum(["indexed", "demo"]),
  })
  .openapi("NotificationPage");

export type NotificationPage = z.infer<typeof NotificationPageSchema>;
export type AlertSettings = z.infer<typeof AlertSettingsSchema>;

export const NotificationUpdateSchema = z
  .object({ type: z.literal("changed") })
  .openapi("NotificationUpdate");
