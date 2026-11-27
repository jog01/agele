import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { decimal } from "../src/lib/decimal";
import { comments, positions, theses, trades, users } from "../src/models";
import { PgFollowRepository } from "../src/repositories/follow.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { CommentSchema, FeedSchema, ThesisThreadSchema } from "../src/schemas/social";
import { USDC_MINT } from "../src/services/helius-parser";
import type { UserService } from "../src/services/user.service";
import { SOL, socialDemoFixture, testApp } from "./helpers";

describe("social controller", () => {
  const app = testApp();
  const fixture = socialDemoFixture();
  beforeAll(fixture.setUp);
  afterAll(fixture.tearDown);

  it("ranks the leaderboard by PnL", async () => {
    const res = await app.request("/v1/leaderboard?window=7d&limit=10");
    const body = (await res.json()) as { window: string; entries: { rank: number; pnlUsd: number }[] };
    expect(body.window).toBe("7d");
    expect(body.entries).toHaveLength(10);
    for (let i = 1; i < body.entries.length; i++) {
      expect(body.entries[i - 1]!.pnlUsd).toBeGreaterThanOrEqual(body.entries[i]!.pnlUsd);
      expect(body.entries[i]!.rank).toBe(i + 1);
    }
  });

  it("returns comments for a known token and 404s otherwise", async () => {
    expect((await app.request(`/v1/tokens/${SOL}/comments`)).status).toBe(200);
    expect((await app.request("/v1/tokens/11111111111111111111111111111111/comments")).status).toBe(404);
  });

  it("documents that a thesis thread can have no pinned version", async () => {
    const document = await (await app.request("/openapi.json")).json();
    expect(document.components.schemas.ThesisThread.properties.pinned).toMatchObject({
      anyOf: [{ $ref: "#/components/schemas/Comment" }, { type: "null" }],
    });
  });
});

describe("persistent discussions and follows", () => {
  const db = getDb();
  const wallet = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const viewerId = crypto.randomUUID();
  const viewer = { id: viewerId, walletAddress: wallet, wallets: [] };
  const makeApp = () =>
    testApp({
      follows: new PgFollowRepository(db),
      auth: { verify: async () => ({ privyDid: "did:privy:discussion-test", sessionId: "s" }) },
      users: { ensureUser: async () => viewer } as unknown as UserService,
    });
  const app = makeApp();
  const headers = { authorization: "Bearer good", "content-type": "application/json" };
  const token = `/v1/tokens/${SOL}`;
  const write = (route: string, body: object) =>
    app.request(`${token}/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  let oldPosition: string;
  let closedPosition: string;
  let openPosition: string;
  beforeAll(async () => {
    await db.insert(users).values({ id: viewerId, walletAddress: wallet, privyDid: `did:privy:${viewerId}` });
    const repository = new PgTradeRepository(db);
    const now = Math.floor(Date.now() / 1000);
    const fill = (side: "buy" | "sell", age: number) =>
      repository.record({
        userId: viewerId,
        wallet,
        mint: SOL,
        side,
        amount: decimal("2"),
        usd: decimal("20"),
        quoteMint: USDC_MINT,
        quoteAmount: decimal("20"),
        signature: crypto.randomUUID(),
        timestamp: now - age,
        symbol: "SOL",
        name: "Wrapped SOL",
        decimals: 9,
        imageUrl: null,
      });
    oldPosition = (await fill("buy", 15_000))!.id;
    const closingFill = (await fill("sell", 15_000))!;
    await db
      .update(trades)
      .set({ id: "00000000-0000-4000-8000-000000000000" })
      .where(eq(trades.id, closingFill.id));
    closedPosition = (await fill("buy", 200))!.id;
    await fill("sell", 150);
    openPosition = (await fill("buy", 100))!.id;
  });
  afterAll(async () => {
    await db.delete(comments).where(eq(comments.userId, viewerId));
    await db.delete(theses).where(eq(theses.userId, viewerId));
    await db.delete(trades).where(eq(trades.userId, viewerId));
    await db.delete(positions).where(eq(positions.userId, viewerId));
    await db.delete(users).where(eq(users.id, viewerId));
  });

  it("writes versions, nested replies, pins and idempotent likes, then reads them via a new app", async () => {
    expect((await write("theses", { body: "Expired", positionId: oldPosition })).status).toBe(409);
    expect(
      (await write("theses", { body: "Closed within the window", positionId: closedPosition })).status,
    ).toBe(201);
    expect((await write("comments", { body: "x".repeat(201) })).status).toBe(400);
    expect((await write("comments", { body: "Join discord.gg/rooms" })).status).toBe(422);
    viewer.walletAddress = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const first = await write("theses", { body: "x".repeat(3000), positionId: openPosition });
    expect(first.status).toBe(201);
    const version = CommentSchema.parse(await first.json());
    viewer.walletAddress = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const update = CommentSchema.parse(
      await (await write("theses", { body: "Scaled down after the bounce." })).json(),
    );
    expect(update.thesisId).toBe(version.thesisId);
    const reply = CommentSchema.parse(
      await (await write("comments", { body: "What invalidates this?", parentId: version.id })).json(),
    );
    const nested = CommentSchema.parse(
      await (await write("comments", { body: "A close below support.", parentId: reply.id })).json(),
    );
    expect(nested.thesisId).toBe(version.thesisId);
    expect(nested.parentId).toBe(reply.id);
    for (let i = 0; i < 2; i++) {
      expect((await app.request(`/v1/posts/${version.id}/reaction`, { method: "PUT", headers })).status).toBe(
        204,
      );
      expect((await app.request(`/v1/posts/${version.id}/pin`, { method: "PUT", headers })).status).toBe(204);
    }
    const restoredApp = makeApp();
    const thread = ThesisThreadSchema.parse(
      await (await restoredApp.request(`${token}/theses/${version.thesisId}`, { headers })).json(),
    );
    expect(thread).toMatchObject({
      positionId: openPosition,
      wallet,
      pinned: { id: version.id, likes: 1, likedByMe: true },
    });
    expect(thread.comments).toHaveLength(4);
    const feed = FeedSchema.parse(await (await restoredApp.request("/v1/feed")).json());
    expect(feed.items.find((item) => item.id === version.id)).toMatchObject({
      source: "indexed",
      likes: 1,
      replyCount: 2,
      pinned: true,
    });
    for (const suffix of ["reaction", "pin"]) {
      expect(
        (await restoredApp.request(`/v1/posts/${version.id}/${suffix}`, { method: "DELETE", headers }))
          .status,
      ).toBe(204);
    }
    expect((await write("comments", { body: "Rate limited." })).status).toBe(429);
  });

  it("limits follow churn over a short window and keeps retries idempotent", async () => {
    const targets = Array.from({ length: 11 }, () =>
      getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))),
    );
    for (const target of targets.slice(0, 10)) {
      expect((await app.request(`/v1/follows/${target}`, { method: "PUT", headers })).status).toBe(204);
    }
    expect((await app.request(`/v1/follows/${targets[0]}`, { method: "PUT", headers })).status).toBe(204);
    expect((await app.request(`/v1/follows/${targets[10]}`, { method: "PUT", headers })).status).toBe(429);
  });
});
