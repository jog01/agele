import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { requireAuth } from "../middlewares/auth";
import { errorResponse } from "../schemas/common";
import { MeSchema } from "../schemas/user";
import type { AppEnv } from "../types";

const getMe = createRoute({
  method: "get",
  path: "/me",
  tags: ["users"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { "application/json": { schema: MeSchema } }, description: "Current user" },
    401: errorResponse("Missing or invalid token"),
  },
});

export const meController = new OpenAPIHono<AppEnv>().openapi(getMe, async (c) => {
  const user = await c.get("container").users.ensureUser(c.get("auth"));
  return c.json(
    { id: user.id, privyDid: user.privyDid, walletAddress: user.walletAddress, handle: user.handle },
    200,
  );
});
