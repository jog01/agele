import { createMiddleware } from "hono/factory";
import { unauthorized } from "../lib/errors";
import type { AppEnv } from "../types";

/** Requires `Authorization: Bearer <privy access token>`; sets `auth` claims. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) throw unauthorized("Missing bearer token");
  c.set("auth", await c.get("container").auth.verify(token));
  await next();
});
