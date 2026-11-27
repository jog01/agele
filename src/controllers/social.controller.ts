import { createRoute, OpenAPIHono, type RouteConfig, z } from "@hono/zod-openapi";
import { isAddress } from "@solana/kit";
import { optionalAuth, requireAuth } from "../middlewares/auth";
import { errorResponse, MintParam } from "../schemas/common";
import {
  CommentBody,
  CommentPage,
  CommentQuery,
  CommentSchema,
  FeedQuery,
  FeedSchema,
  LeaderboardEntrySchema,
  LeaderboardQuery,
  LeaderboardWindow,
  SocialPostBody,
  ThesisThreadSchema,
} from "../schemas/social";
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
        "Top traders by realized + unrealized PnL. Seeded entries have source=demo. X-Data-Source is demo for an entirely seeded page, indexed otherwise.",
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
    "Social activity newest first with keyset pagination. Defaults to trades and theses; request milestone, multi-user or new-trader via types. Following scope requires a bearer token.",
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
      409: errorResponse("Follow cap reached"),
      429: errorResponse("Follow rate limit reached"),
      503: errorResponse("Authentication is not configured"),
    },
  });

const getComments = createRoute({
  method: "get",
  path: "/tokens/{mint}/comments",
  tags: ["social"],
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: { params: MintParam, query: CommentQuery },
  responses: {
    200: {
      content: { "application/json": { schema: CommentPage } },
      description: "Theses and comments on a token, newest first",
    },
    400: errorResponse("Invalid query or cursor"),
    401: errorResponse("Invalid bearer token"),
    404: errorResponse("Unknown token"),
    503: errorResponse("Authentication is not configured"),
  },
});

const writeResponses = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or invalid bearer token"),
  404: errorResponse("Unknown token, thesis or post"),
  503: errorResponse("Authentication is not configured"),
};
const postResponses = {
  ...writeResponses,
  409: errorResponse("Thesis update window expired"),
  422: errorResponse("Text rejected by moderation"),
  429: errorResponse("Post rate limit reached"),
};
const getThesis = createRoute({
  method: "get",
  path: "/tokens/{mint}/theses/{thesisId}",
  tags: ["social"],
  security: optionalSecurity,
  middleware: [optionalAuth] as const,
  request: {
    params: MintParam.extend({ thesisId: z.uuid().openapi({ param: { name: "thesisId", in: "path" } }) }),
    query: CommentQuery,
  },
  responses: {
    200: {
      content: { "application/json": { schema: ThesisThreadSchema } },
      description: "Thesis versions and replies, newest first, with the pinned version returned separately",
    },
    ...writeResponses,
  },
});
const postThesis = createRoute({
  method: "post",
  path: "/tokens/{mint}/theses",
  tags: ["social"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  description:
    "Publish a thesis version for an open position or one closed at most three hours ago. Omit positionId to use the most recent position.",
  request: {
    params: MintParam,
    body: { required: true, content: { "application/json": { schema: SocialPostBody } } },
  },
  responses: {
    201: { content: { "application/json": { schema: CommentSchema } }, description: "Published thesis" },
    ...postResponses,
  },
});
const postComment = createRoute({
  method: "post",
  path: "/tokens/{mint}/comments",
  tags: ["social"],
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  description: "Publish a token comment or reply to a thesis on the same token.",
  request: {
    params: MintParam,
    body: { required: true, content: { "application/json": { schema: CommentBody } } },
  },
  responses: {
    201: { content: { "application/json": { schema: CommentSchema } }, description: "Published comment" },
    ...postResponses,
  },
});
const reactionRoute = (method: "put" | "delete") =>
  createRoute({
    method,
    path: "/posts/{id}/reaction",
    tags: ["social"],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: { params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: {
      204: { description: method === "put" ? "Post liked (idempotent)" : "Post unliked (idempotent)" },
      ...writeResponses,
    },
  });
const pinRoute = (method: "put" | "delete") =>
  createRoute({
    method,
    path: "/posts/{id}/pin",
    tags: ["social"],
    security: [{ bearerAuth: [] }],
    middleware: [requireAuth] as const,
    request: { params: z.object({ id: z.uuid().openapi({ param: { name: "id", in: "path" } }) }) },
    responses: {
      204: { description: "Thesis version pin updated (author only)" },
      ...writeResponses,
    },
  });

export const socialController = new OpenAPIHono<AppEnv>()
  .openapi(getLeaderboard, async (c) => {
    const { window, limit } = c.req.valid("query");
    const container = c.get("container");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    const entries = await container.social.leaderboard(window, limit, viewer?.id);
    c.header(
      "X-Data-Source",
      entries.length && entries.every((entry) => entry.source === "demo") ? "demo" : "indexed",
    );
    return c.json({ window, entries }, 200);
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
    const container = c.get("container");
    const { mint } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    return c.json(await container.social.comments(mint, limit, cursor, viewer?.id), 200);
  })
  .openapi(postThesis, async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    return c.json(
      await container.social.post(viewer, c.req.valid("param").mint, "thesis", c.req.valid("json")),
      201,
    );
  })
  .openapi(getThesis, async (c) => {
    const container = c.get("container");
    const { mint, thesisId } = c.req.valid("param");
    const { limit, cursor } = c.req.valid("query");
    const viewer = c.get("auth") ? await container.users.ensureUser(c.get("auth")) : undefined;
    return c.json(await container.social.thesisThread(mint, thesisId, limit, cursor, viewer?.id), 200);
  })
  .openapi(postComment, async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    return c.json(
      await container.social.post(viewer, c.req.valid("param").mint, "comment", c.req.valid("json")),
      201,
    );
  })
  .openapi(reactionRoute("put"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.react(c.req.valid("param").id, viewer.id, true);
    return c.body(null, 204);
  })
  .openapi(reactionRoute("delete"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.react(c.req.valid("param").id, viewer.id, false);
    return c.body(null, 204);
  })
  .openapi(pinRoute("put"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.pin(c.req.valid("param").id, viewer.id, true);
    return c.body(null, 204);
  })
  .openapi(pinRoute("delete"), async (c) => {
    const container = c.get("container");
    const viewer = await container.users.ensureUser(c.get("auth"));
    await container.social.pin(c.req.valid("param").id, viewer.id, false);
    return c.body(null, 204);
  });
