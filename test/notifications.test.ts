import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { eq, inArray } from "drizzle-orm";
import { env } from "../src/config/env";
import { getDb } from "../src/db/client";
import { decimal } from "../src/lib/decimal";
import { unauthorized } from "../src/lib/errors";
import { comments, follows, notifications, positions, theses, trades, users, wallets } from "../src/models";
import { PgFollowRepository } from "../src/repositories/follow.repository";
import { PgLeaderboardRepository } from "../src/repositories/leaderboard.repository";
import {
  DEMO_INBOX_USER_ID,
  insertNotifications,
  PgNotificationRepository,
} from "../src/repositories/notification.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { NotificationPageSchema } from "../src/schemas/notification";
import { CommentSchema } from "../src/schemas/social";
import { USDC_MINT } from "../src/services/helius-parser";
import { LeaderboardService } from "../src/services/leaderboard.service";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { NotificationService } from "../src/services/notification.service";
import { notificationTopic } from "../src/ws/topics";
import { MemoryLeaderboard } from "./fixtures/leaderboard-store";
import { SOL, socialDemoFixture, testApp } from "./helpers";

const db = getDb();
const inbox = "/v1/me/notifications";
const settings = `${inbox}/settings`;
const account = (name: string) => ({
  id: crypto.randomUUID(),
  privyDid: `did:privy:${crypto.randomUUID()}`,
  walletAddress: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))),
  handle: `notification-${name}`,
});

describe("demo notification inbox", () => {
  const fixture = socialDemoFixture();
  const viewer = account("demo-viewer");
  const second = account("demo-second");
  const headers = { authorization: "Bearer demo" };
  const secondHeaders = { authorization: "Bearer second" };
  const app = testApp({
    auth: {
      async verify(token) {
        const user = token === "demo" ? viewer : token === "second" ? second : undefined;
        if (!user) throw unauthorized();
        return { privyDid: user.privyDid, sessionId: "demo-test" };
      },
    },
  });
  const privateKey = `test:${crypto.randomUUID()}`;
  beforeAll(async () => {
    await fixture.setUp();
    await db.insert(users).values([viewer, second]);
    await insertNotifications(db, [
      {
        recipientId: DEMO_INBOX_USER_ID,
        eventKey: privateKey,
        details: { kind: "leaderboard", target: { window: "24h", rank: 99, previousRank: null } },
      },
    ]);
  });
  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.eventKey, privateKey));
    await db.delete(users).where(inArray(users.id, [viewer.id, second.id]));
    await fixture.tearDown();
  });

  it("paginates persisted demo data and excludes private records belonging to the seed account", async () => {
    const first = await app.request(`${inbox}?limit=2&cursor=`, { headers });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const page = NotificationPageSchema.parse(await first.json());
    expect(page.source).toBe("demo");
    expect(page.items[0]).toMatchObject({
      kind: "thesis_like",
      actorCount: 3,
      readAt: null,
      target: { mint: SOL, symbol: "SOL", imageUrl: expect.stringMatching(/^https:\/\//) },
    });
    expect(page.items[0]?.actors).toHaveLength(3);
    expect(page.items[1]).toMatchObject({ kind: "thesis_comment", readAt: null });
    const item = page.items[0]!;
    if (item.kind !== "thesis_like") throw new Error("Expected a thesis notification");
    const { target } = item;
    expect((await app.request(`/v1/tokens/${target.mint}/theses/${target.thesisId}`)).status).toBe(200);
    const next = NotificationPageSchema.parse(
      await (await app.request(`${inbox}?cursor=${page.nextCursor}`, { headers })).json(),
    );
    expect(next.items.map(({ kind }) => kind)).toEqual(["follow", "trader_trade", "leaderboard"]);
    expect(next.items[0]).toMatchObject({ kind: "follow", actorCount: 3, readAt: expect.any(Number) });
    expect(next.nextCursor).toBeNull();
    expect((await app.request(`${inbox}?cursor=bad`, { headers })).status).toBe(400);
    expect((await app.request(inbox, { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    expect((await app.request(settings)).status).toBe(401);
  });

  it("marks demo groups read once and isolates read state by signed-in account", async () => {
    const get = (path: string, auth = headers) => app.request(path, { headers: auth });
    const mark = (path: string, auth = headers) => app.request(path, { headers: auth, method: "PUT" });
    const count = `${inbox}/unread-count`;
    expect(await (await get(count)).json()).toEqual({ unreadCount: 3 });
    const page = NotificationPageSchema.parse(await (await get(inbox)).json());
    const likes = page.items.find(({ kind }) => kind === "thesis_like")!;
    const markLikes = `${inbox}/${encodeURIComponent(likes.id)}/read`;
    expect(await (await mark(markLikes)).json()).toEqual({ unreadCount: 2 });
    expect(await (await mark(markLikes)).json()).toEqual({ unreadCount: 2 });
    const reread = NotificationPageSchema.parse(await (await get(inbox)).json());
    expect(reread.items.find(({ id }) => id === likes.id)?.readAt).not.toBeNull();
    expect(await (await mark(`${inbox}/read-all`)).json()).toEqual({ unreadCount: 0 });
    expect(await (await get(count, secondHeaders)).json()).toEqual({ unreadCount: 3 });
  });

  it("requires a bearer in live mode", async () => {
    const original = env.MARKET_DATA_PROVIDER;
    try {
      env.MARKET_DATA_PROVIDER = "live";
      expect((await app.request(inbox)).status).toBe(401);
    } finally {
      env.MARKET_DATA_PROVIDER = original;
    }
  });
});

describe("account notifications", () => {
  const author = account("author");
  const follower = account("follower");
  const quiet = account("quiet");
  const accounts = [author, follower, quiet];
  const originalProvider = env.MARKET_DATA_PROVIDER;
  const market = new MockMarketDataProvider();
  const delivered: { topic: string; data: unknown }[] = [];
  const events = {
    publish(topic: string, data: unknown) {
      delivered.push({ topic, data });
    },
  };
  const delivery = new NotificationService(new PgNotificationRepository(db), events);
  const app = testApp({
    events,
    follows: new PgFollowRepository(db, delivery.inboxChanged),
    auth: {
      async verify(token) {
        const user = accounts.find(({ id }) => id === token);
        if (!user) throw unauthorized();
        return { privyDid: user.privyDid, sessionId: "test" };
      },
    },
  });
  const headers = (user: typeof author) => ({
    authorization: `Bearer ${user.id}`,
    "content-type": "application/json",
  });
  const read = async (user: typeof author) =>
    NotificationPageSchema.parse(await (await app.request(inbox, { headers: headers(user) })).json());
  const change = (user: typeof author, body: Record<string, unknown>) =>
    app.request(settings, {
      method: "PUT",
      headers: headers(user),
      body: JSON.stringify(body),
    });
  const fill = async (writer: PgTradeRepository, signature: string = crypto.randomUUID()) => {
    const token = (await market.getToken(SOL))!;
    return writer.record({
      userId: author.id,
      wallet: author.walletAddress,
      mint: SOL,
      side: "buy",
      amount: decimal("2"),
      usd: decimal("20"),
      quoteMint: USDC_MINT,
      quoteAmount: decimal("20"),
      signature,
      timestamp: Math.floor(Date.now() / 1000) - 10,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      imageUrl: token.imageUrl,
    });
  };

  beforeAll(async () => {
    env.MARKET_DATA_PROVIDER = "live";
    await db.insert(users).values([author, { ...follower, walletAddress: null }, quiet]);
    await db.insert(wallets).values({
      userId: follower.id,
      address: follower.walletAddress,
      chainType: "solana",
      walletClientType: "external",
    });
  });
  afterAll(async () => {
    env.MARKET_DATA_PROVIDER = originalProvider;
    await db.delete(comments).where(inArray(comments.userId, [author.id, follower.id]));
    await db.delete(theses).where(eq(theses.userId, author.id));
    await db.delete(trades).where(eq(trades.userId, author.id));
    await db.delete(positions).where(eq(positions.userId, author.id));
    await db.delete(follows).where(
      inArray(
        follows.followerId,
        accounts.map(({ id }) => id),
      ),
    );
    await db.delete(users).where(
      inArray(
        users.id,
        accounts.map(({ id }) => id),
      ),
    );
  });

  it("persists and groups follow events, links thesis likes, and keeps inboxes private", async () => {
    const initial = await fill(new PgTradeRepository(db));
    const [thesis] = await db
      .insert(theses)
      .values({
        userId: author.id,
        wallet: author.walletAddress,
        mint: SOL,
        positionId: initial!.id,
      })
      .returning();
    const [post] = await db
      .insert(comments)
      .values({
        userId: author.id,
        mint: SOL,
        kind: "thesis",
        thesisId: thesis!.id,
        body: "Long SOL",
      })
      .returning();
    const follow = (user: typeof author) =>
      app.request(`/v1/follows/${author.walletAddress}`, { method: "PUT", headers: headers(user) });
    const react = (user: typeof author) =>
      app.request(`/v1/posts/${post!.id}/reaction`, { method: "PUT", headers: headers(user) });
    expect((await follow(follower)).status).toBe(204);
    expect((await follow(follower)).status).toBe(204);
    expect((await follow(quiet)).status).toBe(204);
    expect((await react(author)).status).toBe(204);
    expect((await react(follower)).status).toBe(204);
    expect((await react(follower)).status).toBe(204);

    const authorInbox = await read(author);
    expect(authorInbox.source).toBe("indexed");
    expect(authorInbox.items).toHaveLength(2);
    expect(authorInbox.items.find(({ kind }) => kind === "follow")).toMatchObject({ actorCount: 2 });
    expect(authorInbox.items.find(({ kind }) => kind === "thesis_like")).toMatchObject({
      actorCount: 1,
      target: { thesisId: thesis!.id, commentId: post!.id, positionId: initial!.id },
      actors: [{ wallet: follower.walletAddress }],
    });
    const comment = await app.request(`/v1/tokens/${SOL}/comments`, {
      method: "POST",
      headers: headers(follower),
      body: JSON.stringify({ parentId: post!.id, body: "My outlook on SOL" }),
    });
    expect(comment.status).toBe(201);
    const reply = CommentSchema.parse(await comment.json());
    const item = (await read(author)).items.find(({ kind }) => kind === "thesis_comment")!;
    expect(item).toMatchObject({
      actorCount: 1,
      target: { thesisId: thesis!.id, commentId: reply.id, positionId: initial!.id, mint: SOL },
    });
    expect(
      (await app.request(`${inbox}/${item.id}/read`, { method: "PUT", headers: headers(follower) })).status,
    ).toBe(404);
    expect((await read(follower)).items).toEqual([]);
    expect(delivered.filter(({ topic }) => topic === notificationTopic(author.walletAddress))).toHaveLength(
      4,
    );
  });

  it("uses persisted settings and notifies enabled followers only once per indexed trade", async () => {
    const setup = new PgFollowRepository(db);
    await setup.follow(follower.id, author.walletAddress);
    await setup.follow(quiet.id, author.walletAddress);
    const get = () => app.request(settings, { headers: headers(follower) });
    expect(await (await get()).json()).toEqual({ traderActivity: true, sound: false });
    expect((await change(follower, { traderActivity: "true", sound: true })).status).toBe(400);
    expect((await change(follower, { traderActivity: true, sound: true })).status).toBe(200);
    expect((await change(quiet, { traderActivity: false, sound: true })).status).toBe(200);
    expect(await (await get()).json()).toEqual({ traderActivity: true, sound: true });
    const writer = new PgTradeRepository(db, delivery.inboxChanged);
    const signature = crypto.randomUUID();
    expect(await fill(writer, signature)).not.toBeNull();
    expect(await fill(writer, signature)).toBeNull();
    expect((await read(follower)).items).toMatchObject([
      {
        kind: "trader_trade",
        target: {
          wallet: author.walletAddress,
          positionId: expect.any(String),
          mint: SOL,
          sizeUsd: 20,
          side: "buy",
        },
        actorCount: 1,
      },
    ]);
    expect((await read(quiet)).items).toEqual([]);
    expect(delivered.filter(({ topic }) => topic === notificationTopic(follower.walletAddress))).toEqual([
      { topic: notificationTopic(follower.walletAddress), data: { type: "changed" } },
      { topic: notificationTopic(follower.walletAddress), data: { type: "changed" } },
    ]);
  });

  it("records a ranked trade's ranking changes without duplicating them on repeat updates", async () => {
    const trade = await fill(new PgTradeRepository(db));
    const leaderboard = new LeaderboardService(
      new PgLeaderboardRepository(db),
      new MemoryLeaderboard(),
      market,
      events,
      Date.now,
      undefined,
      delivery.rankChanged,
    );
    await leaderboard.updateUser(author.id, trade!.id);
    await leaderboard.updateUser(author.id, trade!.id);
    const ranked = (await read(author)).items.filter(({ kind }) => kind === "leaderboard");
    expect(ranked).toHaveLength(3);
    for (const item of ranked) expect(item.target).toMatchObject({ rank: 1, previousRank: null });
  });

  it("emits a rank change during a scheduled rebuild that sees the fill before its listener", async () => {
    const trade = await fill(new PgTradeRepository(db));
    const changed: { userId: string; rank: number }[] = [];
    const leaderboard = new LeaderboardService(
      new PgLeaderboardRepository(db),
      new MemoryLeaderboard(),
      market,
      events,
      Date.now,
      undefined,
      async (userId, _window, rank) => {
        changed.push({ userId, rank });
      },
    );
    await leaderboard.rebuild();
    await leaderboard.updateUser(author.id, trade!.id);
    expect(changed.filter(({ userId }) => userId === author.id)).toEqual(
      Array.from({ length: 3 }, () => ({ userId: author.id, rank: 1 })),
    );
  });

  it("notifies the account displaced by a newly ranked trader", async () => {
    const trade = await fill(new PgTradeRepository(db));
    const store = new MemoryLeaderboard();
    await store.update("7d", quiet.id, {
      userId: quiet.id,
      pnlUsd: -1,
      pnlPct: 0,
      volumeUsd: 1,
      trades: 1,
      winRatePct: 0,
    });
    const leaderboard = new LeaderboardService(
      new PgLeaderboardRepository(db),
      store,
      market,
      events,
      Date.now,
      undefined,
      delivery.rankChanged,
    );
    await leaderboard.updateUser(author.id, trade!.id);
    const rank = (await read(quiet)).items.find(({ kind }) => kind === "leaderboard");
    expect(rank?.target).toMatchObject({ window: "7d", rank: 2, previousRank: 1 });
  });
});
