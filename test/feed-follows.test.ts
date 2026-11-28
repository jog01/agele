import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { createContainer } from "../src/container";
import { getDb } from "../src/db/client";
import { seedSocialDemo } from "../src/db/seed-social";
import { decimal } from "../src/lib/decimal";
import { unauthorized } from "../src/lib/errors";
import {
  chainTokens,
  chainTrades,
  feedDiscussions,
  positions,
  tokens,
  trades,
  users,
  wallets,
} from "../src/models";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import {
  CommentPage,
  CommentSchema,
  FeedEventType,
  type FeedPage,
  FeedSchema,
  type LeaderboardEntryDto,
} from "../src/schemas/social";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { encodeCursor } from "../src/services/social/cursor";
import { TokenService } from "../src/services/token.service";
import type { UserService } from "../src/services/user.service";
import { SOL, socialDemoFixture, testApp } from "./helpers";

const headers = { authorization: "Bearer good" };
const secondary = "11111111111111111111111111111111";
const viewerId = "1fb40aaa-5ec0-4c2e-9b27-8f7e0d7a10ac";
const fixture = socialDemoFixture();
beforeAll(fixture.setUp);
afterAll(fixture.tearDown);

it("prices seeded social positions locally when keyless Jupiter returns 429", async () => {
  const originalKey = env.JUPITER_API_KEY;
  env.JUPITER_API_KEY = undefined;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response(null, { status: 429 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
  try {
    const app = createApp(createContainer());
    const [feed, leaderboard] = await Promise.all([
      app.request("/v1/feed?minPortfolioUsd=1"),
      app.request("/v1/leaderboard?window=30d"),
    ]);
    expect([feed.status, leaderboard.status]).toEqual([200, 200]);
    const { items } = FeedSchema.parse(await feed.json());
    const trade = items.find(
      (item): item is Extract<TraderFeedItem, { kind: "trade" }> =>
        item.kind === "trade" && item.priceSinceFirstBuyPct !== null,
    );
    expect(trade).toBeDefined();
    const { entries } = (await leaderboard.json()) as { entries: LeaderboardEntryDto[] };
    expect(entries.some((entry) => entry.source === "demo" && entry.pnlUsd !== 0)).toBe(true);
    const { wallet, mint } = trade!;
    const profile = await app.request(`/v1/traders/${wallet}`);
    const position = await app.request(`/v1/traders/${wallet}/positions/${mint}`);
    const traders = await app.request(`/v1/tokens/${mint}/traders`);
    expect([profile.status, position.status, traders.status]).toEqual([200, 200, 200]);
    expect(fetch).not.toHaveBeenCalled();

    await getDb().update(users).set({ demo: false }).where(eq(users.walletAddress, wallet));
    try {
      const [mixedFeed, mixedRanks] = await Promise.all([
        app.request(`/v1/feed?wallet=${wallet}`),
        app.request("/v1/leaderboard?window=30d"),
      ]);
      expect([mixedFeed.status, mixedRanks.status]).toEqual([200, 200]);
      const mixed = FeedSchema.parse(await mixedFeed.json());
      expect(mixed.items.length).toBeGreaterThan(0);
      expect(mixed.items.every((item) => item.marketCapUsd === null)).toBe(true);
      expect(fetch).toHaveBeenCalled();
    } finally {
      await getDb().update(users).set({ demo: true }).where(eq(users.walletAddress, wallet));
    }
  } finally {
    env.JUPITER_API_KEY = originalKey;
    fetch.mockRestore();
  }
});

it("uses fresh indexed quotes and refreshes stale Solana quotes through Jupiter", async () => {
  const db = getDb();
  const address = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const wallet = address();
  const mint = address();
  const [user] = await db
    .insert(users)
    .values({ privyDid: `did:privy:${wallet}`, walletAddress: wallet })
    .returning();
  let jupiterAvailable = true;
  let jupiterMarketCap: number | null = 800;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        if (!jupiterAvailable) return new Response(null, { status: 429 });
        return new URL(String(input)).pathname === "/price/v3"
          ? Response.json({ [mint]: { usdPrice: 8 } })
          : Response.json([{ id: mint, symbol: "TEST", name: "Test", decimals: 6, mcap: jupiterMarketCap }]);
      },
      {
        preconnect: globalThis.fetch.preconnect,
      },
    ),
  );
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    await db
      .insert(wallets)
      .values({ userId: user!.id, address: wallet, chainType: "solana", walletClientType: "privy" });
    await new PgTradeRepository(db).record({
      userId: user!.id,
      wallet,
      mint,
      symbol: "TEST",
      name: "Test",
      decimals: 6,
      imageUrl: null,
      amount: decimal("2"),
      usd: decimal("4"),
      quoteAmount: decimal("4"),
      quoteMint: SOL,
      signature: address(),
      side: "buy",
      timestamp,
    });
    const pool = address();
    const orderKey = "0:0:1";
    await db.insert(chainTokens).values({
      source: "solana",
      mint,
      venue: "pump.fun",
      pool,
      creator: wallet,
      name: "Test",
      symbol: "TEST",
      decimals: 6,
      totalSupplyRaw: "100000000",
      launchedAt: timestamp,
      priceUsd: 5,
      lastTradeKey: orderKey,
    });
    await db.insert(chainTrades).values({
      source: "solana",
      signature: address(),
      mint,
      eventIndex: 1,
      trader: wallet,
      side: "buy",
      venue: "pump.fun",
      pool,
      time: timestamp,
      orderKey,
      tokenAmountRaw: "2000000",
      solAmountLamports: "50000000",
      priceUsd: 5,
      amountUsd: 10,
    });
    const container = createContainer();
    const app = createApp(container);
    const feed = await app.request(`/v1/feed?wallet=${wallet}&minPortfolioUsd=9`);
    expect(feed.status).toBe(200);
    expect(FeedSchema.parse(await feed.json()).items).toMatchObject([
      { mint, marketCapUsd: 500, priceSinceFirstBuyPct: 150 },
    ]);
    const rank = await app.request("/v1/leaderboard?window=30d");
    expect(rank.status).toBe(200);
    const { entries } = (await rank.json()) as { entries: LeaderboardEntryDto[] };
    expect(entries.find((entry) => entry.wallet === wallet)?.pnlUsd).toBe(6);
    expect((await container.portfolio.getPositionSummary(user!.id)).unrealizedPnlUsd).toBe(6);
    expect(fetch).not.toHaveBeenCalled();

    await db
      .update(chainTrades)
      .set({ time: timestamp - 600 })
      .where(eq(chainTrades.mint, mint));
    const stale = await app.request(`/v1/feed?wallet=${wallet}`);
    expect(FeedSchema.parse(await stale.json()).items).toMatchObject([
      { mint, marketCapUsd: 800, priceSinceFirstBuyPct: 300 },
    ]);
    expect((await container.portfolio.getPositionSummary(user!.id)).unrealizedPnlUsd).toBe(12);

    jupiterMarketCap = null;
    const partialApp = createApp(createContainer());
    const partial = await partialApp.request(`/v1/feed?wallet=${wallet}&minMarketCapUsd=500`);
    expect(partial.status).toBe(200);
    expect(FeedSchema.parse(await partial.json()).items).toMatchObject([
      { mint, marketCapUsd: 500, priceSinceFirstBuyPct: 300 },
    ]);

    jupiterAvailable = false;
    fetch.mockClear();
    const unavailableApp = createApp(createContainer());
    const outage = await unavailableApp.request(`/v1/feed?wallet=${wallet}`);
    expect(FeedSchema.parse(await outage.json()).items).toMatchObject([
      { mint, marketCapUsd: 500, priceSinceFirstBuyPct: 150 },
    ]);
    expect(fetch).toHaveBeenCalled();

    await db.update(chainTokens).set({ priceUsd: 0 }).where(eq(chainTokens.mint, mint));
    const unpriced = await unavailableApp.request(`/v1/feed?wallet=${wallet}`);
    expect(unpriced.status).toBe(200);
    expect(FeedSchema.parse(await unpriced.json()).items).toMatchObject([{ mint, marketCapUsd: null }]);
    expect(fetch).toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await db.delete(positions).where(eq(positions.userId, user!.id));
    await db.delete(trades).where(eq(trades.userId, user!.id));
    await db.delete(wallets).where(eq(wallets.userId, user!.id));
    await db.delete(users).where(eq(users.id, user!.id));
    await db.delete(chainTrades).where(eq(chainTrades.mint, mint));
    await db.delete(chainTokens).where(eq(chainTokens.mint, mint));
    await db.delete(tokens).where(eq(tokens.mint, mint));
  }
});

function setup(tokens?: TokenService, id = viewerId) {
  const follows = new InMemoryFollowRepository();
  const app = testApp({
    follows,
    ...(tokens ? { tokens } : {}),
    auth: {
      verify: async (token) => {
        if (token !== "good") throw unauthorized("Invalid access token");
        return { privyDid: "did:privy:test", sessionId: "s" };
      },
    },
    users: {
      ensureUser: async () => ({ id, walletAddress: SOL, wallets: [{ address: secondary }] }),
    } as unknown as UserService,
  });
  return { app, follows };
}
async function page(app: ReturnType<typeof testApp>, query = "", authenticated = false) {
  const res = await app.request(`/v1/feed${query}`, { headers: authenticated ? headers : undefined });
  expect(res.status).toBe(200);
  return (await res.json()) as Omit<FeedPage, "items"> & { items: TraderFeedItem[] };
}

type TraderFeedItem = Exclude<FeedPage["items"][number], { kind: "price-spike" | "new-listing" }>;

describe("feed", () => {
  it("keeps new-trader engagement reachable when a late-indexed fill becomes the first trade", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    const wallet = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const { app } = setup(undefined, id);
    const earlierMint = MockMarketDataProvider.mints[1]!;
    const query = `?types=new-trader&wallet=${wallet}`;
    let discussionKey: string | undefined;
    const fill = (mint: string, executedAt: Date) =>
      db.insert(trades).values({
        userId: id,
        mint,
        side: "buy",
        tokenAmount: "1",
        priceUsd: "10",
        quoteAmountUsd: "10",
        signature: crypto.randomUUID(),
        executedAt,
      });
    await db.insert(users).values({ id, privyDid: `privy:engagement:${id}`, walletAddress: wallet });
    try {
      await fill(SOL, new Date("2026-01-02"));
      const [before] = (await page(app, query, true)).items;
      if (before?.kind !== "new-trader") throw new Error("Missing new-trader card");
      discussionKey = before.discussionKey;
      const route = `/v1/feed/${encodeURIComponent(before.discussionKey)}`;
      const reply = (body: string, parentId?: string) =>
        app.request(`${route}/comments`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ body, parentId }),
        });
      expect((await app.request(`${route}/reaction`, { method: "PUT", headers })).status).toBe(204);
      const posted = await reply("Welcome to the feed");
      expect(posted.status).toBe(201);
      const parent = CommentSchema.parse(await posted.json());

      await fill(earlierMint, new Date("2026-01-01"));

      const thread = await app.request(`${route}/comments`);
      expect(thread.status).toBe(200);
      expect(CommentPage.parse(await thread.json()).comments).toMatchObject([{ id: parent.id }]);
      const [after] = (await page(app, query, true)).items;
      expect(after).toMatchObject({
        id: before.id,
        discussionKey: before.discussionKey,
        mint: earlierMint,
        likeCount: 1,
        viewerLiked: true,
        replyCount: 1,
      });
      const nested = await reply("Same trader, earlier fill", parent.id);
      expect(nested.status).toBe(201);
      expect(CommentSchema.parse(await nested.json())).toMatchObject({ mint: SOL, parentId: parent.id });
    } finally {
      if (discussionKey) await db.delete(feedDiscussions).where(eq(feedDiscussions.key, discussionKey));
      await db.delete(trades).where(eq(trades.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("persists independent reactions and threaded replies for trades and derived cards", async () => {
    const db = getDb();
    const id = crypto.randomUUID();
    const { app } = setup(undefined, id);
    const types = FeedEventType.options.filter(
      (type) => !["thesis", "price-spike", "new-listing"].includes(type),
    );
    const cards = await Promise.all(
      types.map(async (type) => {
        const [card] = (await page(app, `?types=${type}&limit=1`)).items;
        if (!card || card.kind === "thesis") throw new Error(`Missing ${type} activity`);
        return card;
      }),
    );
    const path = (key: string) => `/v1/feed/${encodeURIComponent(key)}`;
    const reply = (key: string, body: string, parentId?: string) =>
      app.request(`${path(key)}/comments`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ body, parentId }),
      });
    const buy = cards.find((card) => card.eventType === "bought")!;
    const milestone = cards.find((card) => card.eventType === "milestone")!;
    const keys = cards.map((card) => card.discussionKey);
    await db.insert(users).values({ id, privyDid: `privy:engagement:${id}` });
    try {
      expect(new Set(keys).size).toBe(types.length);
      expect((await app.request(`${path(buy.discussionKey)}/reaction`, { method: "PUT" })).status).toBe(401);
      expect((await app.request(`${path("not-a-key")}/comments`)).status).toBe(400);
      expect((await app.request(`${path(`milestone:${buy.id}`)}/comments`)).status).toBe(404);
      expect(
        (await app.request(`${path(`trade:${crypto.randomUUID()}`)}/reaction`, { method: "PUT", headers }))
          .status,
      ).toBe(404);
      expect((await reply(buy.discussionKey, "Watch discord.gg/invite")).status).toBe(422);
      expect((await reply(buy.discussionKey, "a".repeat(201))).status).toBe(400);
      const posted = await reply(buy.discussionKey, "Watching this fill");
      expect(posted.status).toBe(201);
      const parent = CommentSchema.parse(await posted.json());
      expect(parent.discussionKey).toBe(buy.discussionKey);
      expect((await reply(milestone.discussionKey, "Wrong thread", parent.id)).status).toBe(404);
      expect((await reply(buy.discussionKey, "Watching this fill")).status).toBe(422);
      const nested = await reply(buy.discussionKey, "Same here", parent.id);
      expect(nested.status).toBe(201);
      expect(CommentSchema.parse(await nested.json()).parentId).toBe(parent.id);
      for (const card of cards.filter((card) => card.kind !== "trade")) {
        expect((await reply(card.discussionKey, `Interesting ${card.kind} activity`)).status).toBe(201);
      }
      expect((await reply(buy.discussionKey, "Over the limit")).status).toBe(429);
      const first = await app.request(`${path(buy.discussionKey)}/comments?limit=1`);
      expect(first.status).toBe(200);
      const firstPage = CommentPage.parse(await first.json());
      expect(firstPage.comments).toHaveLength(1);
      expect(firstPage.nextCursor).toBeString();
      const next = await app.request(`${path(buy.discussionKey)}/comments?cursor=${firstPage.nextCursor}`);
      const nextPage = CommentPage.parse(await next.json());
      expect(new Set([...firstPage.comments, ...nextPage.comments].map((comment) => comment.body))).toEqual(
        new Set(["Watching this fill", "Same here"]),
      );
      for (const card of cards) {
        const reaction = `${path(card.discussionKey)}/reaction`;
        for (let i = 0; i < 2; i++) {
          expect((await app.request(reaction, { method: "PUT", headers })).status).toBe(204);
        }
        const query = `?types=${card.eventType}&limit=1`;
        const replyCount = card === buy ? 2 : card.kind !== "trade" ? 1 : 0;
        expect((await page(app, query, true)).items[0]).toMatchObject({
          id: card.id,
          likeCount: 1,
          replyCount,
          viewerLiked: true,
        });
        expect((await page(app, query)).items[0]).toMatchObject({
          id: card.id,
          likeCount: 1,
          replyCount,
          viewerLiked: false,
        });
        for (let i = 0; i < 2; i++) {
          expect((await app.request(reaction, { method: "DELETE", headers })).status).toBe(204);
        }
        expect((await page(app, query, true)).items[0]).toMatchObject({
          likeCount: 0,
          replyCount,
          viewerLiked: false,
        });
      }
    } finally {
      await db.delete(feedDiscussions).where(inArray(feedDiscussions.key, keys));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("keeps persisted feed identities and dates unchanged when the seed is rerun", async () => {
    const { app } = setup();
    const snapshot = await page(app, "?limit=100");
    const first = await page(app, "?limit=1");
    await seedSocialDemo(getDb(), Date.now() + 15 * 60 * 1000);
    const next = await page(app, `?limit=100&cursor=${first.nextCursor}`);
    expect(next.items).toEqual(snapshot.items.slice(1));
    expect(next.nextCursor).toBeNull();

    const fresh = await page(setup().app, "?limit=1");
    expect(fresh).toEqual(first);
  });

  it("returns stable newest-first pages including timestamp ties without duplicates", async () => {
    const { app } = setup();
    let result = await page(app, "?limit=1");
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeString();
    const ids: string[] = [];
    let previous = result.items[0]!;
    for (;;) {
      for (const item of result.items) {
        expect(item.createdAt <= previous.createdAt).toBe(true);
        if (ids.length && item.createdAt === previous.createdAt) expect(item.id < previous.id).toBe(true);
        expect(Number.isInteger(item.createdAt)).toBe(true);
        expect(["long", "short", "none"]).toContain(item.position);
        if (item.kind === "trade") {
          expect(["buy", "sell"]).toContain(item.side);
          expect(item.amountUsd).toBeNumber();
          expect(item).not.toHaveProperty("body");
        } else if (item.kind === "thesis") {
          expect(item.body).toBeString();
          expect(item).not.toHaveProperty("side");
          expect(item).not.toHaveProperty("amountUsd");
        }
        ids.push(item.id);
        previous = item;
      }
      if (!result.nextCursor) break;
      result = await page(app, `?limit=7&cursor=${result.nextCursor}`);
    }
    expect(ids).toHaveLength(96);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await page(app, `?cursor=${encodeCursor({ createdAt: 0, id: viewerId })}`)).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("rejects invalid cursors and query values", async () => {
    const { app } = setup();
    for (const query of [
      "cursor=",
      "cursor=garbage",
      `cursor=${Buffer.from('{"createdAt":1,"id":1}').toString("base64url")}`,
      `cursor=${encodeCursor({ createdAt: 0, id: "demo-0000" })}`,
      `cursor=${encodeCursor({ createdAt: Number.MAX_SAFE_INTEGER, id: "demo-0095" })}`,
      "scope=bad",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "types=bought,nope",
      "minMarketCapUsd=200&maxMarketCapUsd=100",
      "minSizeUsd=-1",
    ]) {
      expect((await app.request(`/v1/feed?${query}`)).status).toBe(400);
    }
  });

  it("emits all requested event variants and paginates a filtered result", async () => {
    const { app } = setup();
    const traderTypes = FeedEventType.options.filter(
      (type) => !["price-spike", "new-listing"].includes(type),
    );
    const types = traderTypes.join(",");
    const first = FeedSchema.parse(await page(app, `?types=${types}&limit=1`));
    const events = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const next = FeedSchema.parse(await page(app, `?types=${types}&limit=100&cursor=${cursor}`));
      events.push(...next.items);
      cursor = next.nextCursor;
    }
    expect(new Set(events.map((item) => item.eventType))).toEqual(new Set(traderTypes));
    expect(new Set(events.map((item) => item.id)).size).toBe(events.length);
    const closed = events.find((item) => item.eventType === "closed");
    expect(closed).toMatchObject({
      kind: "trade",
      side: "sell",
      positionId: expect.any(String),
      realizedPnlUsd: expect.any(Number),
    });
    const groups = await page(app, "?types=multi-user&limit=1");
    expect(groups.items[0]).toMatchObject({ kind: "multi-user", traderCount: 2 });
    const nextGroup = await page(app, `?types=multi-user&limit=1&cursor=${groups.nextCursor}`);
    expect(nextGroup.items[0]?.id).not.toBe(groups.items[0]?.id);
  });

  it("combines trade size, portfolio, cap, wallet, mint and first-buy filters", async () => {
    const { app } = setup();
    const size = 100;
    const query = `types=bought&mint=${SOL}&minSizeUsd=${size}&minPortfolioUsd=1&minMarketCapUsd=1&maxMarketCapUsd=1000000000000&minPriceSinceFirstBuyPct=-99`;
    const result = await page(app, `?${query}`);
    expect(result.items.length).toBeGreaterThan(1);
    for (const item of result.items) {
      expect(item).toMatchObject({ kind: "trade", eventType: "bought", mint: SOL });
      if (item.kind === "trade") {
        expect(item.amountUsd).toBeGreaterThanOrEqual(size);
        expect(item.priceSinceFirstBuyPct).toBeGreaterThanOrEqual(-99);
      }
    }
    const wallet = result.items[0]!.wallet;
    expect((await page(app, `?${query}&wallet=${wallet}`)).items).toEqual(
      result.items.filter((item) => item.wallet === wallet),
    );
    expect(
      (await page(app, `?${query.replace("minPortfolioUsd=1", "minPortfolioUsd=100000000000")}`)).items,
    ).toEqual([]);
  });

  it("does not match absent live quotes represented by zero", async () => {
    const market = new MockMarketDataProvider();
    const getToken = market.getToken.bind(market);
    market.getToken = async (mint) => {
      const token = await getToken(mint);
      return token && { ...token, priceUsd: 0, marketCapUsd: 0 };
    };
    const { app } = setup(new TokenService(market));
    const query = `?types=bought&mint=${SOL}`;
    const unfiltered = await page(app, query);
    expect(unfiltered.items.length).toBeGreaterThan(0);
    expect(unfiltered.items[0]).toMatchObject({ marketCapUsd: null, priceSinceFirstBuyPct: null });
    for (const filter of ["maxMarketCapUsd=100", "minPriceSinceFirstBuyPct=-100", "minPortfolioUsd=0"]) {
      expect((await page(app, `${query}&${filter}`)).items).toEqual([]);
    }
  });

  it("upgrades existing demo activity without replacing fill identities or double-counting gains", async () => {
    const db = getDb();
    const [trader] = await db
      .select()
      .from(users)
      .where(and(eq(users.demo, true), eq(users.handle, "candlejournal")));
    const sale = and(eq(trades.userId, trader!.id), eq(trades.signature, "demo:candlejournal:1"));
    const [expected] = await db.select().from(trades).where(sale);
    const position = and(eq(positions.userId, trader!.id), eq(positions.mint, expected!.mint));
    const [accounting] = await db.select().from(positions).where(position);
    const route = `?types=milestone,multi-user&mint=${expected!.mint}`;
    await db
      .update(trades)
      .set({
        executedAt: sql`${trades.executedAt} - interval '8 minutes'`,
        quoteAmountUsd: sql`${trades.quoteAmountUsd} - 2000`,
        realizedPnlUsd: sql`${trades.realizedPnlUsd} - 2000`,
      })
      .where(sale);
    await db
      .update(positions)
      .set({ realizedPnlUsd: sql`${positions.realizedPnlUsd} - 2000` })
      .where(position);
    await db
      .update(trades)
      .set({ executedAt: sql`${trades.executedAt} - interval '8 minutes'` })
      .where(
        and(
          eq(trades.userId, trader!.id),
          like(trades.signature, "demo:candlejournal:%"),
          sql`${trades.id} <> ${expected!.id}`,
        ),
      );
    const { app } = setup();
    expect((await page(app, route)).items).toEqual([]);
    await seedSocialDemo(db);
    await seedSocialDemo(db);
    const [restored] = await db.select().from(trades).where(sale);
    const [restoredAccounting] = await db.select().from(positions).where(position);
    expect(restored).toEqual(expected);
    expect(restoredAccounting!.realizedPnlUsd).toBe(accounting!.realizedPnlUsd);
    expect([...new Set((await page(app, route)).items.map((item) => item.eventType))].sort()).toEqual([
      "milestone",
      "multi-user",
    ]);
  });

  it("requires auth for following scope and filters by the viewer's followed wallets", async () => {
    const { app, follows } = setup();
    expect((await app.request("/v1/feed?scope=following")).status).toBe(401);
    expect(await page(app, "?scope=following", true)).toEqual({ items: [], nextCursor: null });
    const wallet = (await page(app)).items[0]!.wallet;
    await follows.follow("another-viewer", wallet);
    expect((await page(app, "?scope=following", true)).items).toEqual([]);
    await app.request(`/v1/follows/${wallet}`, { method: "PUT", headers });
    const result = await page(app, "?scope=following&limit=2", true);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.wallet === wallet)).toBe(true);
    expect((await page(app, `?scope=following&cursor=${result.nextCursor}`, true)).items).toHaveLength(6);
  });
});

describe("follows and optional auth", () => {
  it("makes follow/unfollow idempotent and decorates only authenticated leaderboards", async () => {
    const { app, follows } = setup();
    const leaderboard = async (authed: boolean) => {
      const res = await app.request("/v1/leaderboard", { headers: authed ? headers : undefined });
      expect(res.status).toBe(200);
      return ((await res.json()) as { entries: LeaderboardEntryDto[] }).entries;
    };
    const anonymous = await leaderboard(false);
    expect(anonymous.every((row) => !("isFollowing" in row))).toBe(true);
    expect((await leaderboard(true)).every((row) => row.isFollowing === false)).toBe(true);
    const wallet = anonymous[0]!.wallet;
    for (let i = 0; i < 2; i++) {
      const res = await app.request(`/v1/follows/${wallet}`, { method: "PUT", headers });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    expect(await follows.listWallets(viewerId)).toEqual([wallet]);
    expect((await leaderboard(true)).find((row) => row.wallet === wallet)?.isFollowing).toBe(true);
    for (let i = 0; i < 2; i++)
      expect((await app.request(`/v1/follows/${wallet}`, { method: "DELETE", headers })).status).toBe(204);
    expect(await follows.listWallets(viewerId)).toEqual([]);
    expect((await leaderboard(true)).every((row) => row.isFollowing === false)).toBe(true);
  });

  it("rejects missing, malformed and invalid bearer tokens on protected/optional routes", async () => {
    const { app } = setup();
    for (const [path, method] of [
      ["/v1/leaderboard", "GET"],
      ["/v1/feed", "GET"],
      [`/v1/follows/${SOL}`, "PUT"],
      [`/v1/follows/${SOL}`, "DELETE"],
    ]) {
      for (const authorization of ["Bearer bad", "Basic good", "Bearer ", ""])
        expect((await app.request(path!, { method, headers: { authorization } })).status).toBe(401);
      if (method !== "GET") expect((await app.request(path!, { method })).status).toBe(401);
    }
  });

  it("validates addresses and rejects following any owned wallet", async () => {
    const { app } = setup();
    for (const wallet of ["bad", "0".repeat(44), "z".repeat(44), "1".repeat(33)]) {
      for (const method of ["PUT", "DELETE"])
        expect((await app.request(`/v1/follows/${wallet}`, { method, headers })).status).toBe(400);
    }
    for (const wallet of [SOL, secondary])
      expect((await app.request(`/v1/follows/${wallet}`, { method: "PUT", headers })).status).toBe(400);
  });

  it("uses the same valid wallets and handles in feed and every leaderboard window", async () => {
    const { app } = setup();
    const feed = await page(app, "?limit=100");
    for (const window of ["24h", "7d", "30d"] as const) {
      const response = await app.request(`/v1/leaderboard?window=${window}&limit=100`);
      const { entries: rows } = (await response.json()) as { entries: LeaderboardEntryDto[] };
      expect(
        feed.items.every((item) =>
          rows.some((row) => row.wallet === item.wallet && row.handle === item.handle),
        ),
      ).toBe(true);
    }
  });
});
