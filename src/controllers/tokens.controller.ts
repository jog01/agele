import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponse, MintParam } from "../schemas/common";
import {
  CandleSchema,
  CandlesQuery,
  HoldersQuery,
  ListQuery,
  TokenHoldersSchema,
  TokenSchema,
  TradeSchema,
} from "../schemas/token";
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

const getHolders = createRoute({
  method: "get",
  path: "/tokens/{mint}/holders",
  tags: ["tokens"],
  request: { params: MintParam, query: HoldersQuery },
  responses: {
    200: json(TokenHoldersSchema, "Largest token accounts merged by owner wallet"),
    404: errorResponse("Unknown token"),
    502: errorResponse("Market data upstream unavailable"),
  },
});

export const tokensController = new OpenAPIHono<AppEnv>()
  .openapi(getHolders, async (c) => {
    const { mint } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    return c.json(await c.get("container").tokens.getHolders(mint, limit), 200);
  })
  .openapi(listTrending, async (c) => {
    const { limit } = c.req.valid("query");
    return c.json({ tokens: await c.get("container").tokens.listTrending(limit) }, 200);
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
