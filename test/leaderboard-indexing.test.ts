import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { createContainer } from "../src/container";
import * as schema from "../src/models";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import { PgLeaderboardRepository } from "../src/repositories/leaderboard.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { FeedSchema } from "../src/schemas/social";
import { LeaderboardService } from "../src/services/leaderboard.service";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TradeIndexer } from "../src/services/trade-indexer";
import type { UserService } from "../src/services/user.service";
import { WsHub } from "../src/ws/hub";
import { buy, MINT, WALLET } from "./fixtures/helius";
import { MemoryLeaderboard } from "./fixtures/leaderboard-store";
import { FIXED_NOW } from "./helpers";

describe("indexed leaderboard wiring", () => {
  const sql = postgres(env.DATABASE_URL);
  const db = drizzle(sql, { schema, casing: "snake_case" });
  const suffix = crypto.randomUUID();
  const mint = `${MINT}-${suffix}`;
  const address = `${WALLET}-${suffix}`;
  let userId: string;
  const market = new MockMarketDataProvider();
  const store = new MemoryLeaderboard();
  const hub = new WsHub();
  const leaderboard = new LeaderboardService(
    new PgLeaderboardRepository(db),
    store,
    market,
    hub,
    () => FIXED_NOW,
  );
  const indexer = new TradeIndexer(new PgTradeRepository(db), market);
  beforeAll(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ privyDid: `did:privy:${suffix}`, walletAddress: address })
      .returning();
    userId = user!.id;
    await db
      .insert(schema.wallets)
      .values({ userId, address, chainType: "solana", walletClientType: "privy", isPrimary: true });
  });
  afterAll(async () => {
    if (userId) {
      await db.delete(schema.trades).where(eq(schema.trades.userId, userId));
      await db.delete(schema.positions).where(eq(schema.positions.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
    await db.delete(schema.tokens).where(eq(schema.tokens.mint, mint));
    await sql.end();
  });

  it("selects demo vs indexed rankings from webhook configuration and keeps comments mock", async () => {
    const original = env.HELIUS_WEBHOOK_SECRET;
    try {
      env.HELIUS_WEBHOOK_SECRET = undefined;
      const mock = createContainer({ market, leaderboardStore: store });
      const demo = await createApp(mock).request("/v1/leaderboard");
      expect(mock.leaderboard).toBeUndefined();
      expect(demo.headers.get("X-Data-Source")).toBe("demo");
      env.HELIUS_WEBHOOK_SECRET = "configured";
      const real = createContainer({ market, leaderboardStore: store });
      expect(real.leaderboard).toBeInstanceOf(LeaderboardService);
      expect(real.social.leaderboardDemo).toBe(false);
      expect(await real.social.leaderboard("24h", 25)).toEqual([]);
      const sol = MockMarketDataProvider.mints[0]!;
      expect(await real.social.comments(sol, 1)).toHaveLength(1);
    } finally {
      env.HELIUS_WEBHOOK_SECRET = original;
    }
  });

  it("publishes exact WS invalidations after indexing and GET returns indexed user ranks", async () => {
    const publish = spyOn(hub, "publish");
    const container = createContainer({
      market,
      leaderboardStore: store,
      leaderboard,
      tradeIndexer: indexer,
      events: hub,
    });
    const app = createApp(container);
    const tx = {
      ...buy,
      signature: `lb-${suffix}`,
      feePayer: address,
      accountData: buy.accountData.map((account) => ({
        ...account,
        account: account.account === WALLET ? address : account.account,
        tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
          ...change,
          userAccount: address,
          mint: change.mint === MINT ? mint : change.mint,
        })),
      })),
    };
    try {
      expect(await indexer.index([tx])).toEqual({ indexed: 1, skipped: 0 });
      expect(publish.mock.calls).toEqual(
        ["24h", "7d", "30d"].map((window) => ["leaderboard:global", { window, updatedAt: FIXED_NOW / 1000 }]),
      );
      const response = await app.request("/v1/leaderboard?window=24h");
      expect(response.headers.get("X-Data-Source")).toBe("indexed");
      expect(await response.json()).toEqual({
        window: "24h",
        entries: [
          {
            rank: 1,
            wallet: address,
            handle: address.slice(0, 8),
            pnlUsd: 0,
            pnlPct: 0,
            volumeUsd: 100,
            trades: 1,
            winRatePct: 0,
          },
        ],
      });
      await indexer.index([tx]);
      expect(publish).toHaveBeenCalledTimes(3);
    } finally {
      publish.mockRestore();
    }
  });

  it("adds viewer follow state to indexed ranks without changing anonymous ranks or the demo feed", async () => {
    const follows = new InMemoryFollowRepository();
    const app = createApp(
      createContainer({
        market,
        leaderboardStore: store,
        leaderboard,
        follows,
        auth: { verify: async () => ({ privyDid: "did:privy:viewer", sessionId: "session" }) },
        users: { ensureUser: async () => ({ id: "viewer" }) } as unknown as UserService,
      }),
    );
    const read = async (authenticated: boolean) => {
      const response = await app.request(
        "/v1/leaderboard",
        authenticated ? { headers: { authorization: "Bearer good" } } : undefined,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { entries: { wallet: string; isFollowing?: boolean }[] };
    };
    expect((await read(true)).entries[0]).toMatchObject({ wallet: address, isFollowing: false });
    await follows.follow("viewer", address);
    expect((await read(true)).entries[0]).toMatchObject({ wallet: address, isFollowing: true });
    expect((await read(false)).entries[0]).not.toHaveProperty("isFollowing");
    await follows.unfollow("viewer", address);
    expect((await read(true)).entries[0]!.isFollowing).toBe(false);
    const feed = await app.request("/v1/feed?limit=1");
    expect(feed.status).toBe(200);
    expect(FeedSchema.parse(await feed.json()).items).toHaveLength(1);
    const followingFeed = await app.request("/v1/feed?scope=following", {
      headers: { authorization: "Bearer good" },
    });
    expect(FeedSchema.parse(await followingFeed.json()).items).toEqual([]);
  });
});
