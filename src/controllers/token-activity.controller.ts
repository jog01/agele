import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "../middlewares/auth";
import { errorResponse, MintParam } from "../schemas/common";
import { TokenPositionResponse, TokenTradersQuery, TokenTradersResponse } from "../schemas/token-activity";
import type { AppEnv } from "../types";

const position = createRoute({
  method: "get",
  path: "/tokens/{mint}/positions",
  tags: ["tokens"],
  description:
    "Viewer's indexed position, including closed positions. Missing/zero price falls back to average cost. X-Data-Source: indexed.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { params: MintParam },
  responses: {
    200: {
      description: "Position or null when the viewer has none",
      content: { "application/json": { schema: TokenPositionResponse } },
    },
    400: errorResponse("Invalid mint"),
    401: errorResponse("Missing or invalid bearer token"),
    404: errorResponse("Unknown token"),
    503: errorResponse("Authentication is not configured"),
  },
});

const traders = createRoute({
  method: "get",
  path: "/tokens/{mint}/traders",
  tags: ["tokens"],
  description:
    "Indexed users ranked by lifetime token volume USD descending, ties by user ID ascending. Buys/sells are trade counts; PnL is lifetime realized plus current open unrealized. Keyset pagination is live, not snapshot-isolated. X-Data-Source: indexed.",
  request: { params: MintParam, query: TokenTradersQuery },
  responses: {
    200: {
      description: "Traders and opaque next cursor; empty when no indexed trades exist",
      content: { "application/json": { schema: TokenTradersResponse } },
    },
    400: errorResponse("Invalid mint, limit or cursor"),
    404: errorResponse("Unknown token"),
  },
});

export const tokenActivityController = new OpenAPIHono<AppEnv>()
  .openapi(position, async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    const result = await container.tokenActivity.getPosition(viewer.id, c.req.valid("param").mint);
    c.header("X-Data-Source", "indexed");
    return c.json(result, 200);
  })
  .openapi(traders, async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const result = await c
      .get("container")
      .tokenActivity.getTraders(c.req.valid("param").mint, limit, cursor);
    c.header("X-Data-Source", "indexed");
    return c.json(result, 200);
  });
