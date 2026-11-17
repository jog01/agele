import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi";
import { isAddress } from "@solana/kit";
import { optionalAuth, requireAuth } from "../middlewares/auth";
import { errorResponse, MintParam } from "../schemas/common";
import {
  CommentSchema,
  FeedQuery,
  FeedSchema,
  LeaderboardEntrySchema,
  LeaderboardQuery,
  LeaderboardWindow,
} from "../schemas/social";
import { ListQuery } from "../schemas/token";
import type { AppEnv } from "../types";

const optionalSecurity: RouteConfig["security"] = [{}, { bearerAuth: [] }];

const getLeaderboard = createRoute({
  method: "get",
  path: "/leaderboard",
  tags: ["social"],
  request: { query: LeaderboardQuery },
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ window: LeaderboardWindow, entries: z.array(LeaderboardEntrySchema) }),
        },
      },
      description:
        "Top traders by realized + unrealized PnL. X-Data-Source is demo for mock rankings, indexed otherwise.",
    },
    401: errorResponse("Invalid bearer token"),
    503: errorResponse("Authentication is not configured"),
  },
});

const getFeed = createRoute({
  method: "get",
  path: "/feed",
  tags: ["social"],
  description:
    "Newest first with stable keyset pagination. Feed content remains demo data, independent of indexed leaderboard rankings. Following scope requires a bearer token.",
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { query: FeedQuery },
  responses: {
    200: { content: { "application/json": { schema: FeedSchema } }, description: "Social feed" },
    400: errorResponse("Invalid query or cursor"),
    401: errorResponse("Missing or invalid bearer token"),
    503: errorResponse("Authentication is not configured"),
  },
});

const WalletParam = z.object({
  wallet: z
    .string()
    .refine(isAddress, "Invalid Solana wallet address")
    .openapi({ param: { name: "wallet", in: "path" } }),
});
const followRoute = (method: "put" | "delete") =>
  createRoute({
    method,
    path: "/follows/{wallet}",
    tags: ["social"],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: { params: WalletParam },
    responses: {
      204: {
        description: method === "put" ? "Wallet followed (idempotent)" : "Wallet unfollowed (idempotent)",
      },
      400: errorResponse("Invalid wallet or cannot follow own wallet"),
      401: errorResponse("Missing or invalid bearer token"),
      503: errorResponse("Authentication is not configured"),
    },
  });

const getComments = createRoute({
  method: "get",
  path: "/tokens/{mint}/comments",
  tags: ["social"],
  request: { params: MintParam, query: ListQuery },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ comments: z.array(CommentSchema) }) } },
      description: "Theses and comments on a token, newest first",
    },
    404: errorResponse("Unknown token"),
  },
});

export const socialController = new OpenAPIHono<AppEnv>()
  .openapi(getLeaderboard, async (c) => {
    const { window, limit } = c.req.valid("query");
    const container = c.get("container");
    c.header("X-Data-Source", container.social.leaderboardDemo ? "demo" : "indexed");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    return c.json({ window, entries: await container.social.leaderboard(window, limit, viewer?.id) }, 200);
  })
  .openapi(getFeed, async (c) => {
    const container = c.get("container");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    return c.json(await container.social.feed(c.req.valid("query"), viewer?.id), 200);
  })
  .openapi(followRoute("put"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.follow(viewer, c.req.valid("param").wallet);
    return c.body(null, 204);
  })
  .openapi(followRoute("delete"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.unfollow(viewer.id, c.req.valid("param").wallet);
    return c.body(null, 204);
  })
  .openapi(getComments, async (c) => {
    const { mint } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    return c.json({ comments: await c.get("container").social.comments(mint, limit) }, 200);
  });
