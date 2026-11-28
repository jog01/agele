import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { env } from "../config/env";
import { unauthorized } from "../lib/errors";
import { optionalAuth, requireAuth } from "../middlewares/auth";
import { DEMO_INBOX_USER_ID } from "../repositories/notification.repository";
import { errorResponse } from "../schemas/common";
import { AlertSettingsSchema, NotificationPageSchema, NotificationQuery } from "../schemas/notification";
import type { AppEnv } from "../types";

const errors = {
  401: errorResponse("Missing or invalid token"),
  503: errorResponse("Authentication is not configured"),
};
const optionalSecurity: RouteConfig["security"] = [{ bearerAuth: [] }, {}];

const inbox = createRoute({
  method: "get",
  path: "/notifications",
  tags: ["notifications"],
  description: "Private inbox for the bearer. Without a bearer, only demo mode serves the synthetic inbox.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { query: NotificationQuery },
  responses: {
    200: { content: { "application/json": { schema: NotificationPageSchema } }, description: "Inbox page" },
    400: errorResponse("Invalid limit or cursor"),
    ...errors,
  },
});

const settings = {
  path: "/notifications/settings" as const,
  tags: ["notifications"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as [typeof requireAuth],
  responses: {
    200: { content: { "application/json": { schema: AlertSettingsSchema } }, description: "Alert settings" },
    ...errors,
  },
};

const getSettings = createRoute({ ...settings, method: "get" });
const putSettings = createRoute({
  ...settings,
  method: "put",
  request: { body: { required: true, content: { "application/json": { schema: AlertSettingsSchema } } } },
  responses: { ...settings.responses, 400: errorResponse("Invalid alert settings") },
});

export const notificationsController = new OpenAPIHono<AppEnv>()
  .openapi(inbox, async (c) => {
    const { notifications, users } = c.get("container");
    const claims = c.get("auth");
    const { limit, cursor } = c.req.valid("query");
    c.header("Cache-Control", "private, no-store");
    if (claims) {
      const user = await users.ensureUser(claims);
      return c.json(await notifications.list(user.id, user.demo ? "demo" : "indexed", limit, cursor), 200);
    }
    if (env.CHAIN_SOURCE !== "demo" || env.MARKET_DATA_PROVIDER !== "indexed")
      throw unauthorized("Missing bearer token");
    return c.json(await notifications.list(DEMO_INBOX_USER_ID, "demo", limit, cursor), 200);
  })
  .openapi(getSettings, async (c) => {
    const { notifications, users } = c.get("container");
    const user = await users.ensureUser(c.get("auth"));
    c.header("Cache-Control", "private, no-store");
    return c.json(await notifications.settings(user.id), 200);
  })
  .openapi(putSettings, async (c) => {
    const { notifications, users } = c.get("container");
    const user = await users.ensureUser(c.get("auth"));
    c.header("Cache-Control", "private, no-store");
    return c.json(await notifications.saveSettings(user.id, c.req.valid("json")), 200);
  });
