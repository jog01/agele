import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi";
import { AppError } from "../lib/errors";
import { optionalAuth } from "../middlewares/auth";
import { errorResponse, MintParam } from "../schemas/common";
import {
  CandleSchema,
  CandlesQuery,
  ListQuery,
  PulseQuery,
  PulseSchema,
  TokenSchema,
  TokenSearchQuery,
  TradeSchema,
} from "../schemas/token";
import { TokenHolderListSchema, TokenHoldersQuery } from "../schemas/token-activity";
import type { AppEnv } from "../types";

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const listTrending = createRoute({
  method: "get",
  path: "/tokens/trending",
  tags: ["tokens"],
  request: { query: ListQuery },
  responses: { 200: json(z.object({ tokens: z.array(TokenSchema) }), "Trending tokens") },
});

const searchTokens = createRoute({
  method: "get",
  path: "/tokens/search",
  tags: ["tokens"],
  request: { query: TokenSearchQuery },
  responses: {
    200: json(
      z.object({ tokens: z.array(TokenSchema) }),
      "Exact mint or case-insensitive symbol/name prefix matches",
    ),
    400: errorResponse("Invalid query"),
    502: errorResponse("Market data upstream unavailable"),
  },
});

const search = createRoute({
  method: "get",
  path: "/search",
  tags: ["tokens", "traders"],
  request: { query: TokenSearchQuery },
  responses: {
    200: json(
      z.object({
        tokens: z.array(TokenSchema),
        tokensUnavailable: z
          .boolean()
          .describe("Token provider unavailable; indexed token matches may still be returned."),
        traders: z.array(
          z.object({
            wallet: z.string(),
            handle: z.string(),
            displayName: z.string().nullable(),
            avatarUrl: z.string().nullable(),
          }),
        ),
      }),
      "Token and public trader matches",
    ),
    400: errorResponse("Invalid query"),
  },
});

const listPulse = createRoute({
  method: "get",
  path: "/pulse",
  tags: ["tokens"],
  description:
    "Limit per lane. New is below 7,000 bps; Final stretch starts at 7,000 bps; Migrated requires a migration event. Timestamps are Unix seconds.",
  request: { query: PulseQuery },
  responses: { 200: json(PulseSchema, "Pulse lanes"), 400: errorResponse("Invalid limit") },
});

const getToken = createRoute({
  method: "get",
  path: "/tokens/{mint}",
  tags: ["tokens"],
  request: { params: MintParam },
  responses: { 200: json(TokenSchema, "Token"), 404: errorResponse("Unknown token") },
});

const getCandles = createRoute({
  method: "get",
  path: "/tokens/{mint}/candles",
  tags: ["tokens"],
  request: { params: MintParam, query: CandlesQuery },
  responses: {
    200: json(z.object({ candles: z.array(CandleSchema) }), "OHLCV candles, oldest first"),
    404: errorResponse("Unknown token"),
  },
});

const getTrades = createRoute({
  method: "get",
  path: "/tokens/{mint}/trades",
  tags: ["tokens"],
  request: { params: MintParam, query: ListQuery },
  responses: {
    200: json(z.object({ trades: z.array(TradeSchema) }), "Recent trades, newest first"),
    404: errorResponse("Unknown token"),
  },
});

const optionalSecurity: RouteConfig["security"] = [{}, { bearerAuth: [] }];

const getHolders = createRoute({
  method: "get",
  path: "/tokens/{mint}/holders",
  tags: ["tokens"],
  description:
    "scope=all: largest owner wallets from market data, enriched when a wallet belongs to an Agele trader. scope=traders: Agele traders with an open indexed position, by amount (first 200). thesisOnly, followingOnly and minValueUsd run before limit. Bearer token optional; required for followingOnly. X-Data-Source: indexed for scope=traders.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { params: MintParam, query: TokenHoldersQuery },
  responses: {
    200: json(TokenHolderListSchema, "Holders with trader, open position and latest thesis"),
    401: errorResponse("followingOnly without a viewer, or invalid bearer token"),
    404: errorResponse("Unknown token"),
    502: errorResponse("Market data upstream unavailable"),
    503: errorResponse("Authentication is not configured"),
  },
});

export const tokensController = new OpenAPIHono<AppEnv>()
  .openapi(getHolders, async (c) => {
    const container = c.get("container");
    const query = c.req.valid("query");
    const auth = c.get("auth");
    const viewer = auth ? await container.users.ensureUser(auth) : undefined;
    const result = await container.tokenHolders.list(c.req.valid("param").mint, query, viewer?.id);
    if (query.scope === "traders") c.header("X-Data-Source", "indexed");
    return c.json(result, 200);
  })
  .openapi(listTrending, async (c) => {
    const { limit } = c.req.valid("query");
    return c.json({ tokens: await c.get("container").tokens.listTrending(limit) }, 200);
  })
  .openapi(searchTokens, async (c) => {
    const { q } = c.req.valid("query");
    return c.json({ tokens: await c.get("container").tokens.searchTokens(q) }, 200);
  })
  .openapi(search, async (c) => {
    const { q } = c.req.valid("query");
    const container = c.get("container");
    const [tokenResult, traders] = await Promise.all([
      container.tokens.searchTokensWithStatus(q).catch((error: unknown) => {
        if (error instanceof AppError && (error.status === 502 || error.status === 503))
          return { tokens: [], tokensUnavailable: true };
        throw error;
      }),
      container.traders.search(q),
    ]);
    return c.json({ ...tokenResult, traders }, 200);
  })
  .openapi(listPulse, async (c) => {
    const { limit } = c.req.valid("query");
    const pulse = await c.get("container").tokens.listPulse(limit);
    c.header("X-Data-Source", pulse.source);
    return c.json(pulse, 200);
  })
  .openapi(getToken, async (c) => {
    const { mint } = c.req.valid("param");
    return c.json(await c.get("container").tokens.getToken(mint), 200);
  })
  .openapi(getCandles, async (c) => {
    const { mint } = c.req.valid("param");
    const { interval, limit } = c.req.valid("query");
    return c.json({ candles: await c.get("container").tokens.getCandles(mint, interval, limit) }, 200);
  })
  .openapi(getTrades, async (c) => {
    const { mint } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    return c.json({ trades: await c.get("container").tokens.getRecentTrades(mint, limit) }, 200);
  });
