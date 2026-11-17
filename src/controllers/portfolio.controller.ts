import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "../middlewares/auth";
import { errorResponse } from "../schemas/common";
import {
  HistoryQuery,
  PortfolioHistorySchema,
  PortfolioSchema,
  UserTradesQuery,
  UserTradesSchema,
} from "../schemas/portfolio";
import type { AppEnv } from "../types";

const portfolio = createRoute({
  method: "get",
  path: "/me/portfolio",
  tags: ["users"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: { description: "Current portfolio", content: { "application/json": { schema: PortfolioSchema } } },
    401: errorResponse("Missing or invalid token"),
    503: errorResponse("Authentication is not configured"),
  },
});
const history = createRoute({
  method: "get",
  path: "/me/portfolio/history",
  tags: ["users"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { query: HistoryQuery },
  responses: {
    200: {
      description: "Daily equity with final live point",
      content: { "application/json": { schema: PortfolioHistorySchema } },
    },
    400: errorResponse("Invalid range"),
    401: errorResponse("Missing or invalid token"),
    503: errorResponse("Authentication is not configured"),
  },
});
const trades = createRoute({
  method: "get",
  path: "/me/trades",
  tags: ["users"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { query: UserTradesQuery },
  responses: {
    200: {
      description: "User trades, newest first",
      content: { "application/json": { schema: UserTradesSchema } },
    },
    400: errorResponse("Invalid limit or cursor"),
    401: errorResponse("Missing or invalid token"),
    503: errorResponse("Authentication is not configured"),
  },
});

export const portfolioController = new OpenAPIHono<AppEnv>()
  .openapi(portfolio, async (c) => {
    const container = c.get("container");
    const user = await container.users.ensureUser(c.get("auth"));
    return c.json(await container.portfolio.getPortfolio(user.id), 200);
  })
  .openapi(history, async (c) => {
    const container = c.get("container");
    const user = await container.users.ensureUser(c.get("auth"));
    return c.json(await container.portfolio.getHistory(user.id, c.req.valid("query").range), 200);
  })
  .openapi(trades, async (c) => {
    const container = c.get("container");
    const user = await container.users.ensureUser(c.get("auth"));
    const { limit, cursor } = c.req.valid("query");
    return c.json(await container.portfolio.getTrades(user.id, limit, cursor), 200);
  });
