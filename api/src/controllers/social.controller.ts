import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponse, MintParam } from "../schemas/common";
import {
  CommentSchema,
  LeaderboardEntrySchema,
  LeaderboardQuery,
  LeaderboardWindow,
} from "../schemas/social";
import { ListQuery } from "../schemas/token";
import type { AppEnv } from "../types";

const getLeaderboard = createRoute({
  method: "get",
  path: "/leaderboard",
  tags: ["social"],
  request: { query: LeaderboardQuery },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ window: LeaderboardWindow, entries: z.array(LeaderboardEntrySchema) }),
        },
      },
      description: "Top traders by realized + unrealized PnL",
    },
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
    return c.json({ window, entries: await c.get("container").social.leaderboard(window, limit) }, 200);
  })
  .openapi(getComments, async (c) => {
    const { mint } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    return c.json({ comments: await c.get("container").social.comments(mint, limit) }, 200);
  });
