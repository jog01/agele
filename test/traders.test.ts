import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBase58Decoder } from "@solana/kit";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../src/config/env";
import { decimal } from "../src/lib/decimal";
import { AppError, unauthorized } from "../src/lib/errors";
import * as schema from "../src/models";
import { PgFollowRepository } from "../src/repositories/follow.repository";
import { PgLeaderboardRepository } from "../src/repositories/leaderboard.repository";
import { PgPortfolioRepository } from "../src/repositories/portfolio.repository";
import { PgSocialRepository } from "../src/repositories/social.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { PgTraderRepository } from "../src/repositories/trader.repository";
import { UserTradesSchema } from "../src/schemas/portfolio";
import { TraderConnectionsSchema, TraderPositionSchema, TraderProfileSchema } from "../src/schemas/trader";
import { USDC_MINT } from "../src/services/helius-parser";
import { LeaderboardService } from "../src/services/leaderboard.service";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { PortfolioService } from "../src/services/portfolio.service";
import { LEADERBOARD_WINDOWS } from "../src/services/social/leaderboard-store";
import { TokenService } from "../src/services/token.service";
import { TraderService } from "../src/services/trader.service";
import type { UserService } from "../src/services/user.service";
import { MemoryLeaderboard } from "./fixtures/leaderboard-store";
import { FIXED_NOW, SOL, testApp } from "./helpers";

describe("public trader profiles", () => {
  const sql = postgres(env.DATABASE_URL, { max: 3 });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  const address = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const wallets = Array.from({ length: 6 }, address);
  const mint = address();
  const legacyWallet = address();
  const ids: string[] = [];
  let viewerId: string;
  let price: number | null = 15;
  let priceError = false;
  let balanceCalls = 0;
  const market = Object.assign(new MockMarketDataProvider(), {
    async searchTokens(query: string) {
      if (query === "@TRADER-") throw new AppError(502, "upstream_error", "Unavailable");
      return query === "SOL" ? [(await originalGetToken(SOL))!] : [];
    },
  });
  const originalGetToken = market.getToken.bind(market);
  market.getToken = async (requested) => {
    if (priceError) throw new Error("Market unavailable");
    if (requested !== mint || price === null) return null;
    return { ...(await originalGetToken(SOL))!, mint, symbol: "TEST", priceUsd: price };
  };
  const follows = new PgFollowRepository(db);
  const portfolio = new PortfolioService(new PgPortfolioRepository(db), market, {
    getBalances: async () => {
      balanceCalls++;
      throw new Error("Profiles must not query wallet balances");
    },
  });
  const store = new MemoryLeaderboard();
  const leaderboard = new LeaderboardService(
    new PgLeaderboardRepository(db),
    store,
    market,
    { publish: () => {} },
    () => FIXED_NOW,
  );
  const repository = new PgTraderRepository(db);
  const social = new PgSocialRepository(db);
  const traders = new TraderService(repository, portfolio, leaderboard, follows, true, market, social);
  const app = testApp({
    market,
    tokens: new TokenService(market),
    portfolio,
    leaderboard,
    leaderboardStore: store,
    follows,
    traders,
    auth: {
      verify: async (token) => {
        if (token !== "good") throw unauthorized("Invalid bearer token");
        return { privyDid: "did:privy:viewer", sessionId: "session" };
      },
    },
    users: { ensureUser: async () => ({ id: viewerId }) } as unknown as UserService,
  });
  const request = (wallet = wallets[0]!, suffix = "", authed = false) =>
    app.request(
      `/v1/traders/${wallet}${suffix}`,
      authed ? { headers: { authorization: "Bearer good" } } : undefined,
    );
  let demoWallet: string;

  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      const [user] = await db
        .insert(schema.users)
        .values({
          privyDid: `did:privy:${wallets[i]}`,
          walletAddress: wallets[i]!,
          handle: i === 0 ? `trader-${mint}` : null,
          avatarUrl: i === 0 ? "https://example.com/avatar.png" : null,
        })
        .returning();
      ids.push(user!.id);
      await db.insert(schema.wallets).values({
        userId: user!.id,
        address: wallets[i]!,
        chainType: "solana",
        walletClientType: "privy",
        isPrimary: true,
      });
    }
    viewerId = ids[2]!;
    const [legacy] = await db
      .insert(schema.users)
      .values({ privyDid: `did:privy:${legacyWallet}`, walletAddress: legacyWallet })
      .returning();
    ids.push(legacy!.id);
    await db
      .insert(schema.wallets)
      .values({ userId: ids[0]!, address: wallets[4]!, chainType: "solana", walletClientType: "external" });
    const writer = new PgTradeRepository(db);
    const record = (index: number, side: "buy" | "sell", amount: string, usd: string, days: number) =>
      writer.record({
        userId: ids[index]!,
        wallet: wallets[index]!,
        mint,
        signature: crypto.randomUUID(),
        timestamp: FIXED_NOW / 1000 - days * 86400,
        decimals: 6,
        side,
        amount: decimal(amount),
        usd: decimal(usd),
        marketCapUsd: (1_000_000 * Number(usd)) / Number(amount),
        quoteMint: USDC_MINT,
        quoteAmount: decimal(usd),
        symbol: "TEST",
        name: "Test",
        imageUrl: null,
      });
    await record(0, "buy", "10", "100", 40);
    await record(0, "sell", "4", "60", 0);
    await record(0, "buy", "2", "10", 2);
    await record(1, "buy", "1", "10", 0);
    demoWallet = wallets[2]!;
    await db
      .update(schema.users)
      .set({ demo: true, bio: "Trades for the sample journal." })
      .where(inArray(schema.users.id, [ids[2]!]));
    await record(2, "buy", "2", "30", 0);
    await follows.follow(ids[2]!, wallets[0]!);
    await follows.follow(ids[2]!, wallets[4]!);
    await follows.follow(ids[1]!, wallets[4]!);
    await follows.follow(ids[0]!, wallets[1]!);
    await follows.follow(ids[0]!, demoWallet);
    await db.insert(schema.portfolioSnapshots).values([
      { userId: ids[0]!, day: "2025-12-31", valueUsd: "999" },
      { userId: ids[0]!, day: "2026-01-01", valueUsd: "999", positionsValueUsd: "120" },
    ]);
    await leaderboard.rebuild();
  });
  afterAll(async () => {
    if (ids.length) {
      await db.delete(schema.trades).where(inArray(schema.trades.userId, ids));
      await db.delete(schema.positions).where(inArray(schema.positions.userId, ids));
      await db.delete(schema.portfolioSnapshots).where(inArray(schema.portfolioSnapshots.userId, ids));
      await db.delete(schema.users).where(inArray(schema.users.id, ids));
    }
    await db.delete(schema.tokens).where(inArray(schema.tokens.mint, [mint]));
    await sql.end();
  });

  it("resolves linked wallet aliases and reuses leaderboard window stats plus portfolio PnL", async () => {
    const response = await request(wallets[4]);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Source")).toBe("indexed");
    const profile = TraderProfileSchema.parse(await response.json());
    expect(profile).toMatchObject({
      wallet: wallets[0],
      handle: `trader-${mint}`,
      avatarUrl: "https://example.com/avatar.png",
      followers: 2,
      following: 2,
      realizedPnlUsd: 20,
      unrealizedPnlUsd: 50,
      positions: [
        {
          mint,
          quantity: 8,
          avgCostUsd: 8.75,
          priceUsd: 15,
          valueUsd: 120,
          unrealizedPnlUsd: 50,
          realizedPnlUsd: 20,
        },
      ],
    });
    expect(profile).not.toHaveProperty("isFollowing");
    expect(profile.stats["24h"]).toEqual({
      pnlUsd: 70,
      pnlPct: 0,
      volumeUsd: 60,
      trades: 1,
      winRatePct: 100,
      rank: 1,
    });
    expect(profile.stats["7d"]).toEqual({
      pnlUsd: 70,
      pnlPct: 700,
      volumeUsd: 70,
      trades: 2,
      winRatePct: 100,
      rank: 1,
    });
    for (const window of LEADERBOARD_WINDOWS) {
      const entry = (await leaderboard.leaderboard(window, 100)).find((row) => row.wallet === wallets[0])!;
      expect(profile.stats[window]).toMatchObject({
        pnlUsd: entry.pnlUsd,
        pnlPct: entry.pnlPct,
        volumeUsd: entry.volumeUsd,
        trades: entry.trades,
        winRatePct: entry.winRatePct,
        rank: entry.rank,
      });
    }
    expect(balanceCalls).toBe(0);
  });

  it("includes isFollowing only for authenticated viewers across primary and secondary wallets", async () => {
    expect(await (await request(wallets[0], "", true)).json()).toMatchObject({ isFollowing: true });
    expect(await (await request(wallets[4], "", true)).json()).toMatchObject({ isFollowing: true });
    viewerId = ids[3]!;
    try {
      expect(await (await request(wallets[0], "", true)).json()).toMatchObject({ isFollowing: false });
    } finally {
      viewerId = ids[2]!;
    }
  });

  it("returns zero/empty stats and null ranks for known traders without trades", async () => {
    const response = await request(wallets[3]);
    expect(response.status).toBe(200);
    const profile = TraderProfileSchema.parse(await response.json());
    expect(profile).toMatchObject({
      handle: wallets[3]!.slice(0, 8),
      followers: 0,
      following: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      positions: [],
    });
    for (const window of LEADERBOARD_WINDOWS)
      expect(profile.stats[window]).toEqual({
        pnlUsd: 0,
        pnlPct: 0,
        volumeUsd: 0,
        trades: 0,
        winRatePct: 0,
        rank: null,
      });
    expect(await (await request(wallets[3], "/trades")).json()).toEqual({ trades: [], nextCursor: null });
    expect((await request(legacyWallet)).status).toBe(200);
  });

  it.each([null, 0])("uses cost fallback for missing price %s", async (unavailable) => {
    price = unavailable;
    try {
      const profile = TraderProfileSchema.parse(await (await request()).json());
      expect(profile.unrealizedPnlUsd).toBe(0);
      expect(profile.realizedPnlUsd).toBe(20);
      expect(profile.positions[0]).toMatchObject({
        avgCostUsd: 8.75,
        priceUsd: 8.75,
        valueUsd: 70,
        unrealizedPnlUsd: 0,
      });
      expect(profile.stats["24h"].pnlUsd).toBe(20);
    } finally {
      price = 15;
    }
  });

  it("paginates public UserTrade history using the existing /me/trades cursor", async () => {
    const firstResponse = await request(wallets[4], "/trades?limit=2");
    expect(firstResponse.headers.get("X-Data-Source")).toBe("indexed");
    const first = UserTradesSchema.parse(await firstResponse.json());
    expect(first.trades).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    const second = UserTradesSchema.parse(
      await (await request(wallets[0], `/trades?limit=2&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.trades).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.trades, ...second.trades]).toEqual((await portfolio.getTrades(ids[0]!, 100)).trades);
    expect(first.trades[0]).toMatchObject({ side: "sell", realizedPnlUsd: 20 });
    expect(second.trades[0]!.realizedPnlUsd).toBeNull();
  });

  it("serves replay with chronological fills, position metrics and public history", async () => {
    const response = await request(wallets[4], `/positions/${mint}`);
    expect(response.status).toBe(200);
    const position = TraderPositionSchema.parse(await response.json());
    expect(position).toMatchObject({
      wallet: wallets[0],
      quantity: 8,
      avgCostUsd: 8.75,
      avgEntryMarketCapUsd: 110_000_000 / 12,
      avgExitMarketCapUsd: 15_000_000,
      totalInvestedUsd: 110,
      realizedPnlUsd: 20,
      unrealizedPnlUsd: 50,
    });
    expect(position.fills.map((fill) => fill.side)).toEqual(["buy", "buy", "sell"]);
    expect(position.id).toBe(position.fills[0]!.id);
    expect((await request(wallets[0], `/positions/${mint}?positionId=${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    expect(await (await request(wallets[0], "/portfolio/history?range=all")).json()).toEqual({
      points: [{ time: Date.UTC(2026, 0, 1) / 1000, valueUsd: 120 }],
    });
  });

  it("pages and filters position transactions without changing the position investment total", async () => {
    const route = `/positions/${mint}/transactions`;
    const first = await request(wallets[0], `${route}?minSizeUsd=60&limit=1`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      total: 2,
      totalInvestedUsd: 110,
      nextPage: 2,
      transactions: [{ side: "sell", valueUsd: 60, marketCapUsd: 15_000_000 }],
    });
    expect(await (await request(wallets[0], `${route}?minSizeUsd=60&limit=1&page=2`)).json()).toMatchObject({
      total: 2,
      totalInvestedUsd: 110,
      nextPage: null,
      transactions: [{ side: "buy", valueUsd: 100, marketCapUsd: 10_000_000 }],
    });
  });

  it("searches tokens and public traders together, including linked addresses", async () => {
    const response = await app.request("/v1/search?q=SOL");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tokens: [{ mint: SOL }], tokensUnavailable: false });
    expect(await (await app.request("/v1/search?q=%40TRADER-")).json()).toMatchObject({
      tokens: [],
      tokensUnavailable: true,
      traders: expect.arrayContaining([
        expect.objectContaining({ wallet: wallets[0], handle: `trader-${mint}`, source: "indexed" }),
      ]),
    });
    expect(await (await app.request(`/v1/search?q=${wallets[4]}`)).json()).toMatchObject({
      traders: [{ wallet: wallets[0] }],
    });
    const fallback = legacyWallet.slice(0, 8);
    expect(
      await (await app.request(`/v1/search?q=%40${fallback.slice(0, 7).toLowerCase()}`)).json(),
    ).toMatchObject({ traders: [{ wallet: legacyWallet, handle: fallback }] });
  });

  it("finds the displayed fallback handle of every linked wallet for a trader without a saved handle or address", async () => {
    const aliases = [address(), address()];
    const [user] = await db
      .insert(schema.users)
      .values({ privyDid: `did:privy:${aliases[0]}` })
      .returning();
    try {
      await db.insert(schema.wallets).values(
        aliases.map((wallet, index): typeof schema.wallets.$inferInsert => ({
          userId: user!.id,
          address: wallet,
          chainType: "solana",
          walletClientType: "external",
          isPrimary: index === 0,
        })),
      );
      for (const wallet of aliases) {
        const profile = TraderProfileSchema.parse(await (await request(wallet)).json());
        const prefix = profile.handle.slice(0, 7).toLowerCase();
        const found = await app.request(`/v1/search?q=%40${prefix}`);
        expect(await found.json()).toMatchObject({ traders: [{ wallet, handle: profile.handle }] });
      }
    } finally {
      await db.delete(schema.users).where(inArray(schema.users.id, [user!.id]));
    }
  });

  it("returns at most five closed positions ranked by realized dollars", async () => {
    const writer = new PgTradeRepository(db);
    const userId = ids[4]!;
    const ranking = [5, -1, 11, 6, 10, 7];
    const entries = new Map<number, string>();
    for (const [i, pnl] of ranking.entries()) {
      for (const [leg, side] of (["buy", "sell"] as const).entries()) {
        const usd = decimal(String(side === "buy" ? 20 : 20 + pnl));
        const row = await writer.record({
          userId,
          wallet: legacyWallet,
          mint,
          side,
          usd,
          symbol: "TEST",
          name: "Test",
          decimals: 6,
          amount: decimal("1"),
          quoteMint: USDC_MINT,
          quoteAmount: usd,
          imageUrl: null,
          signature: crypto.randomUUID(),
          timestamp: FIXED_NOW / 1000 - 90 * 86_400 + i * 10 + leg,
        });
        if (side === "buy") entries.set(pnl, row!.id);
      }
    }
    const response = await request(legacyWallet);
    const profile = TraderProfileSchema.parse(await response.json());
    expect(
      profile.topTrades.map(({ positionId, realizedPnlUsd, realizedPnlPct }) => ({
        positionId,
        realizedPnlUsd,
        realizedPnlPct,
      })),
    ).toEqual(
      [11, 10, 7, 6, 5].map((pnl) => ({
        positionId: entries.get(pnl)!,
        realizedPnlUsd: pnl,
        realizedPnlPct: pnl * 5,
      })),
    );
  });

  it("returns hourly or daily public position changes without disclosing cash", async () => {
    const day = Date.UTC(2026, 0, 1);
    const hour = 3_600_000;
    const repo = new PgPortfolioRepository(db);
    const history = new PortfolioService(
      repo,
      market,
      {
        getBalances: async () => {
          throw new Error("must not request balances");
        },
      },
      () => FIXED_NOW,
    );
    await repo.upsertHourlyPositions(ids[0]!, new Date(FIXED_NOW - 24 * hour), "80");
    await repo.upsertHourlyPositions(ids[0]!, new Date(FIXED_NOW), "120");
    expect(await history.getPublicPositionsHistory(ids[0]!, "24h")).toMatchObject({
      changeUsd: 40,
      changePct: 50,
      points: [{ valueUsd: 80 }, { valueUsd: 120 }],
    });
    await repo.upsertSnapshot(ids[1]!, new Date(day - 7 * 24 * hour).toISOString().slice(0, 10), "999", "80");
    await repo.upsertSnapshot(
      ids[1]!,
      new Date(day - 30 * 24 * hour).toISOString().slice(0, 10),
      "999",
      "100",
    );
    await repo.upsertSnapshot(ids[1]!, "2026-01-01", "999", "120");
    expect(await history.getPublicPositionsHistory(ids[1]!, "7d")).toMatchObject({
      changeUsd: 40,
      changePct: 50,
    });
    expect(await history.getPublicPositionsHistory(ids[1]!, "30d")).toMatchObject({
      changeUsd: 20,
      changePct: 20,
    });
    expect(await history.getPublicPositionsHistory(ids[3]!, "24h")).toEqual({
      points: [],
      changeUsd: null,
      changePct: null,
    });
  });

  it("keyset-paginates distinct followers, returns following edges and annotates mutuals", async () => {
    const result = await request(wallets[4], "/followers?limit=1");
    const page = TraderConnectionsSchema.parse(await result.json());
    expect(page.users).toHaveLength(1);
    expect(page.nextCursor).toBeString();
    const next = TraderConnectionsSchema.parse(
      await (await request(wallets[4], `/followers?cursor=${page.nextCursor}`)).json(),
    );
    expect(new Set([...page.users, ...next.users].map((user) => user.wallet))).toEqual(
      new Set([wallets[1]!, wallets[2]!]),
    );
    const followed = TraderConnectionsSchema.parse(
      await (await request(wallets[0], "/following", true)).json(),
    );
    expect(new Set(followed.users.map((user) => user.wallet))).toEqual(new Set([wallets[1]!, wallets[2]!]));
    const profile = TraderProfileSchema.parse(await (await request(wallets[0], "", true)).json());
    expect(profile).toMatchObject({
      tradeCount: 3,
      avgHoldSeconds: null,
      mutuals: { count: 0, preview: [] },
    });
  });

  it("keeps demo wallet links working with labelled stored stats, holdings and history", async () => {
    const response = await request(demoWallet);
    expect(response.headers.get("X-Data-Source")).toBe("demo");
    expect(TraderProfileSchema.parse(await response.json()).handle).toBe(demoWallet.slice(0, 8));
    const demo = await request(demoWallet, "", true);
    const profile = TraderProfileSchema.parse(await demo.json());
    expect(profile).toMatchObject({
      wallet: demoWallet,
      followers: 1,
      following: 2,
      isFollowing: false,
      bio: "Trades for the sample journal.",
      positions: [{ mint, quantity: 2, avgCostUsd: 15 }],
    });
    for (const window of LEADERBOARD_WINDOWS) {
      const row = (await leaderboard.leaderboard(window, 100)).find((entry) => entry.wallet === demoWallet)!;
      expect(profile.stats[window]).toMatchObject({
        pnlUsd: row.pnlUsd,
        winRatePct: row.winRatePct,
        rank: row.rank,
      });
    }
    const trades = await request(demoWallet, "/trades");
    expect(trades.headers.get("X-Data-Source")).toBe("demo");
    expect(UserTradesSchema.parse(await trades.json()).trades).toHaveLength(1);
  });

  it("reports null ranks if indexing is disabled or the Redis member is absent", async () => {
    const unranked = new TraderService(repository, portfolio, leaderboard, follows, false, market, social);
    expect((await unranked.profile(wallets[0]!)).profile.stats["24h"].rank).toBeNull();
    await store.replace({ "24h": [], "7d": [], "30d": [] });
    try {
      expect((await traders.profile(wallets[0]!)).profile.stats["24h"].rank).toBeNull();
    } finally {
      await leaderboard.rebuild();
    }
  });

  it("rejects unknown traders, malformed input and present invalid bearer tokens", async () => {
    for (const suffix of ["", "/trades"]) {
      expect((await request(wallets[5], suffix)).status).toBe(404);
      expect((await request("invalid", suffix)).status).toBe(400);
      expect(
        (
          await app.request(`/v1/traders/${wallets[0]}${suffix}`, {
            headers: { authorization: "Bearer bad" },
          })
        ).status,
      ).toBe(401);
    }
    for (const wallet of [wallets[0]!, demoWallet]) {
      for (const query of ["limit=0", "limit=101", "cursor=", "cursor=garbage"])
        expect((await request(wallet, `/trades?${query}`)).status).toBe(400);
    }
    priceError = true;
    try {
      expect((await request()).status).toBe(500);
    } finally {
      priceError = false;
    }
  });
});
