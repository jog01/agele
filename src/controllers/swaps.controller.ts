import { createRoute, OpenAPIHono, type z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { AppError } from "../lib/errors";
import { requireAuth } from "../middlewares/auth";
import { errorResponse } from "../schemas/common";
import {
  BuiltSwapSchema,
  QuoteQuery,
  QuoteSchema,
  SubmitSwapRequest,
  SwapIdParam,
  SwapRequest,
  SwapResultSchema,
  SwapStatusSchema,
} from "../schemas/swap";
import type { AppEnv } from "../types";

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or invalid token"),
  404: errorResponse("Swap not found"),
  409: errorResponse("No primary linked wallet"),
  422: errorResponse("Swap or sponsorship rejected"),
  429: errorResponse("Quote rate limit exceeded"),
  502: errorResponse("Jupiter unavailable"),
  503: errorResponse("Trading or quoting unavailable"),
};
const secured = { tags: ["swaps"], security: [{ bearerAuth: [] }], middleware: [requireAuth] };

async function limit(c: Context<AppEnv>, userId?: string) {
  let ip = "unknown";
  try {
    ip = getConnInfo(c).remote.address ?? ip;
  } catch {
    /* Requests without a server share a conservative bucket. */
  }
  const limiter = c.get("container").swapRateLimiter;
  await limiter.consume(`ip:${ip}`);
  if (userId) await limiter.consume(`user:${userId}`);
}

export const swapsController = new OpenAPIHono<AppEnv>()
  .openapi(
    createRoute({
      method: "get",
      path: "/swaps/quote",
      tags: ["swaps"],
      request: { query: QuoteQuery },
      responses: { 200: json(QuoteSchema, "Preview only; no transaction"), ...errors },
    }),
    async (c) => {
      await limit(c);
      return c.json(await c.get("container").swaps.quote(c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      ...secured,
      method: "post",
      path: "/swaps",
      request: { body: { required: true, content: { "application/json": { schema: SwapRequest } } } },
      responses: { 201: json(BuiltSwapSchema, "Swap issued for review and signing"), ...errors },
    }),
    async (c) => {
      const container = c.get("container");
      const user = await container.users.ensureUser(c.get("auth"));
      const wallet = user.wallets.find(
        (w) => w.isPrimary && w.chainType === "solana" && w.address === user.walletAddress,
      );
      if (!wallet) throw new AppError(409, "wallet_not_linked", "No primary linked Solana wallet");
      await limit(c, user.id);
      return c.json(await container.swaps.build(user.id, wallet.address, c.req.valid("json")), 201);
    },
  )
  .openapi(
    createRoute({
      ...secured,
      method: "post",
      path: "/swaps/{requestId}/submit",
      request: {
        params: SwapIdParam,
        body: { required: true, content: { "application/json": { schema: SubmitSwapRequest } } },
      },
      responses: {
        200: json(SwapResultSchema, "Execution result; submitted means outcome unknown"),
        ...errors,
      },
    }),
    async (c) => {
      const container = c.get("container");
      const user = await container.users.ensureUser(c.get("auth"));
      return c.json(
        await container.swaps.submit(
          user.id,
          c.req.valid("param").requestId,
          c.req.valid("json").signedTransaction,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      ...secured,
      method: "get",
      path: "/swaps/{requestId}",
      request: { params: SwapIdParam },
      responses: {
        200: json(SwapStatusSchema, "Owned swap status; amounts are base-unit strings"),
        ...errors,
      },
    }),
    async (c) => {
      const container = c.get("container");
      const user = await container.users.ensureUser(c.get("auth"));
      return c.json(await container.swaps.get(user.id, c.req.valid("param").requestId), 200);
    },
  );
