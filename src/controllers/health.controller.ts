import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../types";

const HealthSchema = z
  .object({ status: z.literal("ok"), uptimeSec: z.number(), marketData: z.enum(["mock", "live"]) })
  .openapi("Health");

const health = createRoute({
  method: "get",
  path: "/health",
  tags: ["system"],
  responses: {
    200: { content: { "application/json": { schema: HealthSchema } }, description: "Liveness" },
  },
});

export const healthController = new OpenAPIHono<AppEnv>().openapi(health, (c) =>
  c.json(
    {
      status: "ok" as const,
      uptimeSec: Math.round(process.uptime()),
      marketData: c.get("container").market.name as "mock" | "live",
    },
    200,
  ),
);
