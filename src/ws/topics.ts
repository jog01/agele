import { z } from "zod";

/**
 * Topic naming: `<entity>:<id>:<stream>`.
 *   token:<mint>:trades   live trades for a token
 *   token:<mint>:price    price ticks for a token
 *   leaderboard:global    leaderboard updates
 *   user:<id>:alerts      private alerts (requires auth, not yet implemented)
 */
export const TOPIC_RE = /^(token:[1-9A-HJ-NP-Za-km-z]{32,44}:(trades|price)|leaderboard:global)$/;

export const ClientMessage = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), topic: z.string().regex(TOPIC_RE) }),
  z.object({ op: z.literal("unsubscribe"), topic: z.string().regex(TOPIC_RE) }),
  z.object({ op: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof ClientMessage>;

export type ServerMessage =
  | { type: "event"; topic: string; data: unknown }
  | { type: "subscribed" | "unsubscribed"; topic: string }
  | { type: "pong" }
  | { type: "error"; message: string };
