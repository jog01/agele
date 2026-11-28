import { z } from "@hono/zod-openapi";
import { LeaderboardWindow } from "./social";

export const NotificationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(256).optional(),
});

export const AlertSettingsSchema = z
  .object({ traderActivity: z.boolean(), sound: z.boolean() })
  .openapi("AlertSettings");

const details = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thesis_like"), thesisId: z.uuid(), postId: z.uuid() }),
  z.object({ kind: z.literal("follow") }),
  z.object({ kind: z.literal("clan_invite"), clanId: z.string(), clanName: z.string() }),
  z.object({ kind: z.literal("send"), signature: z.string(), amount: z.string() }),
  z.object({
    kind: z.literal("leaderboard"),
    window: LeaderboardWindow,
    rank: z.number().int().positive(),
    previousRank: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal("trader_activity"),
    tradeId: z.uuid(),
    signature: z.string(),
    side: z.enum(["buy", "sell"]),
  }),
]);

export type NotificationDetails = z.infer<typeof details>;

const actor = z.object({
  wallet: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

const token = z.object({ mint: z.string(), symbol: z.string(), imageUrl: z.url().nullable() });

export const NotificationPageSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string().describe("Stable notification or follow group ID"),
        createdAt: z.number().describe("Unix seconds; time of the latest event in the group"),
        actors: z.array(actor).max(3),
        count: z.number().int().positive().describe("Events represented by this item"),
        token: token.nullable(),
        details,
      }),
    ),
    nextCursor: z.string().nullable(),
    source: z.enum(["indexed", "demo"]),
  })
  .openapi("NotificationPage");

export type NotificationPage = z.infer<typeof NotificationPageSchema>;
export type AlertSettings = z.infer<typeof AlertSettingsSchema>;

export const NotificationUpdateSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("inbox"), sound: z.boolean() }),
    z.object({ kind: z.literal("settings") }),
  ])
  .openapi("NotificationUpdate");
