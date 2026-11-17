import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { AppEnv } from "../types";

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http_error", message: err.message } }, err.status);
  }
  logger.error({ err, requestId: c.get("requestId") }, "unhandled error");
  return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
};

export const notFoundHandler: NotFoundHandler = (c) =>
  c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404);
