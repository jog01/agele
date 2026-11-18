import { createHash, timingSafeEqual } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { env } from "../config/env";
import { AppError, unauthorized } from "../lib/errors";
import { errorResponse } from "../schemas/common";
import { EnhancedTransactionSchema } from "../services/helius-parser";
import type { AppEnv } from "../types";

const requireWebhookSecret = createMiddleware<AppEnv>(async (c, next) => {
  if (!env.HELIUS_WEBHOOK_SECRET) throw new AppError(503, "webhook_unavailable", "Webhook is not configured");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(c.req.header("Authorization") ?? ""), digest(env.HELIUS_WEBHOOK_SECRET))) {
    throw unauthorized();
  }
  await next();
});

const webhook = createRoute({
  method: "post",
  path: "/webhooks/helius",
  tags: ["webhooks"],
  middleware: [requireWebhookSecret] as const,
  request: {
    body: { required: true, content: { "application/json": { schema: z.array(EnhancedTransactionSchema) } } },
  },
  responses: {
    202: {
      description: "Transactions queued for asynchronous indexing",
      content: {
        "application/json": { schema: z.object({ queued: z.number().int() }) },
      },
    },
    400: errorResponse("Invalid enhanced transactions"),
    401: errorResponse("Invalid webhook secret"),
    503: errorResponse("Webhook unavailable"),
  },
});

export const webhooksController = new OpenAPIHono<AppEnv>().openapi(webhook, async (c) =>
  c.json(await c.get("container").tradeQueue.enqueue(c.req.valid("json")), 202),
);
