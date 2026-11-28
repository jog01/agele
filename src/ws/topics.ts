import { z } from "zod";

/**
 * Topic naming: `<entity>:<id>:<stream>`.
 *   token:<mint>:trades   live trades for a token
 *   token:<mint>:price    price ticks for a token
 *   leaderboard:global    leaderboard updates
 *   pulse                launch, curve and migration updates
 *   user:<wallet>:notifications private inbox and settings updates
 */
export const TOPIC_RE =
  /^(token:[1-9A-HJ-NP-Za-km-z]{32,44}:(trades|price)|leaderboard:global|pulse|user:[1-9A-HJ-NP-Za-km-z]{32,44}:notifications)$/;
export const PRICE_TOPIC_RE = /^token:([1-9A-HJ-NP-Za-km-z]{32,44}):price$/;
export const notificationTopic = (wallet: string) => `user:${wallet}:notifications`;
export const isPrivateTopic = (topic: string) => topic.startsWith("user:");

export const AuthenticateFrame = z.object({
  op: z.literal("authenticate"),
  token: z.string().min(1).max(8192),
});

export const ClientMessage = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), topic: z.string().regex(TOPIC_RE) }),
  z.object({ op: z.literal("unsubscribe"), topic: z.string().regex(TOPIC_RE) }),
  z.object({ op: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: "event"; topic: string; data: unknown }
  | { type: "subscribed" | "unsubscribed"; topic: string }
  | { type: "authenticated" }
  | { type: "pong" }
  | { type: "error"; message: string };
