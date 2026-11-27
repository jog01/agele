import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi";
import { optionalAuth } from "../middlewares/auth";
import { errorResponse, MintParam } from "../schemas/common";
import { PortfolioHistorySchema, UserTradesQuery, UserTradesSchema } from "../schemas/portfolio";
import {
  TraderConnectionsSchema,
  TraderParam,
  TraderPositionSchema,
  TraderProfileSchema,
} from "../schemas/trader";
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
      description: "Trader profile with positions and PnL derived from stored trades",
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
    "Public stored trade history, newest first by executedAt and id. Same UserTrade shape and cursor as /me/trades. X-Data-Source labels indexed or seeded demo history.",
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
const traderReadErrors = {
  400: errorResponse("Invalid input"),
  401: errorResponse("Invalid bearer token"),
  404: errorResponse("Unknown trader or position"),
  503: errorResponse("Authentication is not configured"),
};
const position = createRoute({
  method: "get",
  path: "/traders/{wallet}/positions/{mint}",
  tags: ["traders"],
  description:
    "Public position replay. Returns chronological fills for the selected position episode, or the most recent episode if positionId is omitted.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: {
    params: TraderParam.extend(MintParam.shape),
    query: z.object({ positionId: z.uuid().optional() }),
  },
  responses: {
    200: {
      description: "Position, average entry, PnL and fills",
      content: { "application/json": { schema: TraderPositionSchema } },
    },
    ...traderReadErrors,
  },
});
const connections = (kind: "followers" | "following") =>
  createRoute({
    method: "get",
    path: `/traders/{wallet}/${kind}`,
    tags: ["traders"],
    security: optionalSecurity,
    middleware: [optionalAuth] as const,
    request: { params: TraderParam, query: UserTradesQuery },
    responses: {
      200: {
        description: "Wallet connections newest first; viewer follow state is included when authenticated",
        content: { "application/json": { schema: TraderConnectionsSchema } },
      },
      ...traderReadErrors,
    },
  });
const portfolioHistory = createRoute({
  method: "get",
  path: "/traders/{wallet}/portfolio/history",
  tags: ["traders"],
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: {
    params: TraderParam,
    query: z.object({ range: z.enum(["24h", "7d", "30d", "all"]).default("7d") }),
  },
  responses: {
    200: {
      description:
        "Stored daily value of public positions, oldest first. Excludes cash and linked-wallet balances.",
      content: { "application/json": { schema: PortfolioHistorySchema } },
    },
    ...traderReadErrors,
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
  })
  .openapi(position, async (c) => {
    const { wallet, mint } = c.req.valid("param");
    const result = await c.get("container").traders.position(wallet, mint, c.req.valid("query").positionId);
    c.header("X-Data-Source", result.source);
    return c.json(result.position, 200);
  })
  .openapi(connections("followers"), async (c) => {
    const container = c.get("container");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    const { limit, cursor } = c.req.valid("query");
    const result = await container.traders.connections(
      c.req.valid("param").wallet,
      "followers",
      limit,
      cursor,
      viewer?.id,
    );
    c.header("X-Data-Source", result.source);
    return c.json(result.page, 200);
  })
  .openapi(connections("following"), async (c) => {
    const container = c.get("container");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    const { limit, cursor } = c.req.valid("query");
    const result = await container.traders.connections(
      c.req.valid("param").wallet,
      "following",
      limit,
      cursor,
      viewer?.id,
    );
    c.header("X-Data-Source", result.source);
    return c.json(result.page, 200);
  })
  .openapi(portfolioHistory, async (c) => {
    const result = await c
      .get("container")
      .traders.portfolioHistory(c.req.valid("param").wallet, c.req.valid("query").range);
    c.header("X-Data-Source", result.source);
    return c.json(result.history, 200);
  });
