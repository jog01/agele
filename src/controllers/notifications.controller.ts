import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { env } from "../config/env";
import { requireAuth } from "../middlewares/auth";
import { errorResponse } from "../schemas/common";
import {
  AlertSettingsSchema,
  NotificationPageSchema,
  NotificationQuery,
  UnreadCountSchema,
} from "../schemas/notification";
import type { AppEnv } from "../types";

const prefix = "/me/notifications";
const auth = {
  tags: ["notifications"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as [typeof requireAuth],
};
const errors = {
  401: errorResponse("Missing or invalid token"),
  503: errorResponse("Authentication is not configured"),
};
const unread = {
  200: {
    content: { "application/json": { schema: UnreadCountSchema } },
    description: "Unread inbox item count",
  },
  ...errors,
};
const settings = {
  200: { content: { "application/json": { schema: AlertSettingsSchema } }, description: "Alert settings" },
  ...errors,
};

const inbox = createRoute({
  ...auth,
  method: "get",
  path: prefix,
  description: "Newest notifications first, including seeded data for the signed-in user in demo mode.",
  request: { query: NotificationQuery },
  responses: {
    200: { content: { "application/json": { schema: NotificationPageSchema } }, description: "Inbox page" },
    400: errorResponse("Invalid limit or cursor"),
    ...errors,
  },
});
const getUnreadCount = createRoute({
  ...auth,
  method: "get",
  path: `${prefix}/unread-count`,
  responses: unread,
});
const markRead = createRoute({
  ...auth,
  method: "put",
  path: `${prefix}/{id}/read`,
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .max(128)
        .openapi({ param: { name: "id", in: "path" } }),
    }),
  },
  responses: {
    ...unread,
    400: errorResponse("Invalid notification ID"),
    404: errorResponse("Notification not found"),
  },
});
const markAllRead = createRoute({ ...auth, method: "put", path: `${prefix}/read-all`, responses: unread });
const getSettings = createRoute({ ...auth, method: "get", path: `${prefix}/settings`, responses: settings });
const putSettings = createRoute({
  ...auth,
  method: "put",
  path: `${prefix}/settings`,
  request: { body: { required: true, content: { "application/json": { schema: AlertSettingsSchema } } } },
  responses: { ...settings, 400: errorResponse("Invalid alert settings") },
});

async function inboxUser(c: Context<AppEnv>) {
  const { notifications, users } = c.get("container");
  const user = await users.ensureUser(c.get("auth"));
  c.header("Cache-Control", "private, no-store");
  return { notifications, user, demo: env.CHAIN_SOURCE === "demo" && env.MARKET_DATA_PROVIDER === "indexed" };
}

export const notificationsController = new OpenAPIHono<AppEnv>()
  .openapi(inbox, async (c) => {
    const { notifications, user, demo } = await inboxUser(c);
    const { limit, cursor } = c.req.valid("query");
    return c.json(await notifications.list(user.id, demo ? "demo" : "indexed", limit, cursor), 200);
  })
  .openapi(getUnreadCount, async (c) => {
    const { notifications, user, demo } = await inboxUser(c);
    return c.json(await notifications.unreadCount(user.id, demo), 200);
  })
  .openapi(markRead, async (c) => {
    const { notifications, user, demo } = await inboxUser(c);
    return c.json(await notifications.markRead(user.id, demo, c.req.valid("param").id), 200);
  })
  .openapi(markAllRead, async (c) => {
    const { notifications, user, demo } = await inboxUser(c);
    return c.json(await notifications.markRead(user.id, demo), 200);
  })
  .openapi(getSettings, async (c) => {
    const { notifications, user } = await inboxUser(c);
    return c.json(await notifications.settings(user.id), 200);
  })
  .openapi(putSettings, async (c) => {
    const { notifications, user } = await inboxUser(c);
    return c.json(await notifications.saveSettings(user.id, c.req.valid("json")), 200);
  });
