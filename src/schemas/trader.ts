import { z } from "@hono/zod-openapi";
import { LeaderboardEntrySchema } from "./social";
import { TokenPositionSchema } from "./token-activity";

export const TraderParam = z.object({ wallet: z.string().min(32).max(44) });
const stats = LeaderboardEntrySchema.omit({ wallet: true, handle: true, isFollowing: true, rank: true })
  .extend({ rank: z.number().int().positive().nullable() })
  .openapi("TraderWindowStats");
export const TraderProfileSchema = z
  .object({
    wallet: z.string(),
    handle: z.string(),
    avatarUrl: z.string().nullable(),
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
    isFollowing: z.boolean().optional(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    stats: z.object({ "24h": stats, "7d": stats, "30d": stats }),
    positions: z.array(TokenPositionSchema),
  })
  .openapi("TraderProfile");
