import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { optionalAuth } from "../middlewares/auth";
import { errorResponse } from "../schemas/common";
import { UserTradesQuery, UserTradesSchema } from "../schemas/portfolio";
import { TraderParam, TraderProfileSchema } from "../schemas/trader";
import type { AppEnv } from "../types";

const optionalSecurity: RouteConfig["security"] = [{}, { bearerAuth: [] }];

const profile = createRoute({
  method: "get",
  path: "/traders/{wallet}",
  tags: ["traders"],
  description:
    "Public profile resolved by any linked Solana wallet or legacy primary wallet. Optional auth adds isFollowing. Stats use leaderboard math; Redis rank may lag fresh PostgreSQL stats. X-Data-Source: indexed or demo.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { params: TraderParam },
  responses: {
    200: {
      description: "Trader profile; demo profiles have simulated stats, no holdings or trade history",
      content: { "application/json": { schema: TraderProfileSchema } },
    },
    400: errorResponse("Invalid wallet"),
    401: errorResponse("Invalid bearer token"),
    404: errorResponse("Unknown trader"),
    503: errorResponse("Authentication is not configured"),
  },
});
const trades = createRoute({
  method: "get",
  path: "/traders/{wallet}/trades",
  tags: ["traders"],
  description:
    "Public indexed trade history, newest first by executedAt and id. Same UserTrade shape and cursor as /me/trades. Demo traders return an empty history. X-Data-Source: indexed or demo.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { params: TraderParam, query: UserTradesQuery },
  responses: {
    200: {
      description: "Recent trades and next cursor",
      content: { "application/json": { schema: UserTradesSchema } },
    },
    400: errorResponse("Invalid wallet, limit or cursor"),
    401: errorResponse("Invalid bearer token"),
    404: errorResponse("Unknown trader"),
    503: errorResponse("Authentication is not configured"),
  },
});
export const tradersController = new OpenAPIHono<AppEnv>()
  .openapi(profile, async (c) => {
    const container = c.get("container");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    const result = await container.traders.profile(c.req.valid("param").wallet, viewer?.id);
    c.header("X-Data-Source", result.source);
    return c.json(result.profile, 200);
  })
  .openapi(trades, async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const result = await c.get("container").traders.trades(c.req.valid("param").wallet, limit, cursor);
    c.header("X-Data-Source", result.source);
    return c.json(result.page, 200);
  });
