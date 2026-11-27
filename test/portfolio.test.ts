import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Job } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../src/config/env";
import { createContainer } from "../src/container";
import { createPortfolioSnapshotProcessor } from "../src/jobs/processors/portfolio-snapshot";
import * as schema from "../src/models";
import { PgPortfolioRepository } from "../src/repositories/portfolio.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { PortfolioHistorySchema, UserTradesSchema } from "../src/schemas/portfolio";
import { SOL_MINT } from "../src/services/helius-parser";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { PortfolioService } from "../src/services/portfolio.service";
import { TradeIndexer } from "../src/services/trade-indexer";
import type { UserService } from "../src/services/user.service";
import { buy, MINT, WALLET } from "./fixtures/helius";
import prices from "./fixtures/jupiter-prices.json";
import tokens from "./fixtures/jupiter-tokens.json";
import { FIXED_NOW, testApp } from "./helpers";

describe("portfolio database integration", () => {
  const sql = postgres(env.DATABASE_URL, { max: 3 });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  const repository = new PgPortfolioRepository(db);
  const market = new MockMarketDataProvider();
  const suffix = crypto.randomUUID();
  const mint = `${MINT}-${suffix}`;
  const closedMint = `closed-${suffix}`;
  const addresses = [`${WALLET}-${suffix}-1`, `${WALLET}-${suffix}-2`];
  const userIds: string[] = [];
  const balanceRequests: string[][] = [];
  let price: number | null = 15;
  let solPrice: number | null = 20;
  let solBalance = 0;
  let usdtBalance = 0;
  market.getToken = async (requested) =>
    requested === SOL_MINT && solPrice !== null
      ? { ...(await new MockMarketDataProvider().getToken(SOL_MINT))!, priceUsd: solPrice }
      : requested === mint && price !== null
        ? {
            mint,
            symbol: "TEST",
            name: "Test Token",
            decimals: 6,
            imageUrl: null,
            priceUsd: price,
            priceChange24hPct: 0,
            marketCapUsd: 0,
            liquidityUsd: 0,
            volume24hUsd: 0,
            holders: 0,
          }
        : null;
  const balances = {
    getBalances: async (wallets: string[]) => {
      balanceRequests.push(wallets);
      return {
        usdcBalance: wallets.length ? 50 : 0,
        usdtBalance: wallets.length ? usdtBalance : 0,
        solBalance: wallets.length ? solBalance : 0,
      };
    },
  };
  const portfolio = new PortfolioService(repository, market, balances, () => FIXED_NOW);
  const indexer = new TradeIndexer(new PgTradeRepository(db), market);
  const app = testApp({
    market,
    portfolio,
    balances,
    auth: { verify: async () => ({ privyDid: "did:privy:portfolio", sessionId: "session" }) },
    users: { ensureUser: async () => ({ id: userIds[0]! }) } as unknown as UserService,
  });
  const get = (path: string) => app.request(`/v1/me/${path}`, { headers: { authorization: "Bearer good" } });
  const enhancedBuy = {
    ...buy,
    signature: `multi-buy-${suffix}`,
    feePayer: addresses[0]!,
    accountData: addresses.flatMap((address) =>
      buy.accountData.map((account) => ({
        ...account,
        account: account.account === WALLET ? address : `${account.account}-${address}`,
        nativeBalanceChange:
          account.account === WALLET && address !== addresses[0] ? 0 : account.nativeBalanceChange,
        tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
          ...change,
          userAccount: address,
          mint: change.mint === MINT ? mint : change.mint,
        })),
      })),
    ),
  };

  beforeAll(async () => {
    for (const address of addresses) {
      const [user] = await db
        .insert(schema.users)
        .values({ privyDid: `did:privy:${address}` })
        .returning();
      userIds.push(user!.id);
      await db
        .insert(schema.wallets)
        .values({ userId: user!.id, address, chainType: "solana", walletClientType: "privy" });
    }
  });
  afterAll(async () => {
    if (userIds.length) {
      await db.delete(schema.portfolioSnapshots).where(inArray(schema.portfolioSnapshots.userId, userIds));
      await db.delete(schema.trades).where(inArray(schema.trades.userId, userIds));
      await db.delete(schema.positions).where(inArray(schema.positions.userId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.delete(schema.tokens).where(inArray(schema.tokens.mint, [mint, closedMint]));
    await sql.end();
  });

  it("values a real SOL balance using Jupiter even with indexed market data", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof globalThis.fetch>[0]) =>
          Response.json(new URL(String(input)).pathname === "/price/v3" ? prices : tokens),
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const container = createContainer({
        balances: { getBalances: async () => ({ solBalance: 2, usdcBalance: 0, usdtBalance: 0 }) },
      });
      expect((await container.portfolio.getPortfolio(userIds[0]!)).equityUsd).toBe(
        2 * prices[SOL_MINT].usdPrice,
      );
    } finally {
      fetch.mockRestore();
    }
  });

  it("indexes both linked users in one transaction and deduplicates per user", async () => {
    expect(await indexer.index([enhancedBuy])).toEqual({ indexed: 2, skipped: 0 });
    expect(await indexer.index([enhancedBuy])).toEqual({ indexed: 0, skipped: 2 });
    const rows = await db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.signature, enhancedBuy.signature));
    expect(rows.map((row) => row.userId).sort()).toEqual([...userIds].sort());
    const sell = structuredClone(enhancedBuy);
    sell.signature = `partial-sell-${suffix}`;
    sell.accountData = sell.accountData.filter(
      (account) =>
        account.account === addresses[0] ||
        account.tokenBalanceChanges.some((change) => change.userAccount === addresses[0]),
    );
    for (const account of sell.accountData) {
      for (const change of account.tokenBalanceChanges) {
        change.rawTokenAmount.tokenAmount = change.mint === mint ? "-4000000" : "60000000";
      }
    }
    expect(await indexer.index([sell])).toEqual({ indexed: 1, skipped: 0 });
    await db
      .insert(schema.tokens)
      .values({ mint: closedMint, symbol: "CLOSED", name: "Closed", decimals: 6 });
    await db.insert(schema.positions).values({
      userId: userIds[0]!,
      mint: closedMint,
      quantity: "0",
      costBasisUsd: "0",
      realizedPnlUsd: "7",
    });
  });

  it("returns agreed portfolio math, counting closed realized PnL without listing closed positions", async () => {
    const response = await get("portfolio");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      equityUsd: 140,
      usdcBalance: 50,
      unrealizedPnlUsd: 30,
      realizedPnlUsd: 27,
      positions: [
        {
          mint,
          symbol: "TEST",
          imageUrl: null,
          quantity: 6,
          avgCostUsd: 10,
          priceUsd: 15,
          valueUsd: 90,
          unrealizedPnlUsd: 30,
          realizedPnlUsd: 20,
        },
      ],
    });
    expect(balanceRequests.at(-1)).toEqual([addresses[0]!]);
    try {
      for (const unavailable of [null, 0]) {
        price = unavailable;
        expect(await (await get("portfolio")).json()).toMatchObject({
          equityUsd: 110,
          unrealizedPnlUsd: 0,
          positions: [{ priceUsd: 10, valueUsd: 60 }],
        });
      }
    } finally {
      price = 15;
    }
  });

  it("handles empty portfolios and trade histories", async () => {
    const unknownUser = crypto.randomUUID();
    expect(await portfolio.getPortfolio(unknownUser)).toEqual({
      equityUsd: 0,
      usdcBalance: 0,
      unrealizedPnlUsd: 0,
      realizedPnlUsd: 0,
      positions: [],
    });
    expect(await portfolio.getTrades(unknownUser, 25)).toEqual({ trades: [], nextCursor: null });
    expect(await portfolio.getHistory(unknownUser, "all")).toEqual({
      points: [{ time: FIXED_NOW / 1000, valueUsd: 0 }],
    });
  });

  it("includes USDT and native SOL cash in equity but not in usdcBalance or position PnL", async () => {
    solBalance = 2;
    usdtBalance = 30;
    try {
      expect(await (await get("portfolio")).json()).toMatchObject({
        equityUsd: 210,
        usdcBalance: 50,
        unrealizedPnlUsd: 30,
      });
      expect((await portfolio.getHistory(userIds[0]!, "all")).points.at(-1)!.valueUsd).toBe(210);
      for (const missing of [null, 0]) {
        solPrice = missing;
        expect((await portfolio.getPortfolio(userIds[0]!)).equityUsd).toBe(170);
      }
    } finally {
      solBalance = 0;
      usdtBalance = 0;
      solPrice = 20;
    }
  });

  it("filters daily history by range and appends the live equity point", async () => {
    for (const [day, valueUsd] of [
      ["2025-11-01", "10"],
      ["2025-12-15", "20"],
      ["2025-12-30", "30"],
    ]) {
      await repository.upsertSnapshot(userIds[0]!, day!, valueUsd!);
    }
    const live = { time: FIXED_NOW / 1000, valueUsd: 140 };
    expect(await (await get("portfolio/history")).json()).toEqual({
      points: [{ time: Date.parse("2025-12-30T00:00:00Z") / 1000, valueUsd: 30 }, live],
    });
    expect(
      PortfolioHistorySchema.parse(await (await get("portfolio/history?range=30d")).json()).points,
    ).toHaveLength(3);
    expect(
      PortfolioHistorySchema.parse(await (await get("portfolio/history?range=all")).json()).points,
    ).toHaveLength(4);
    expect((await get("portfolio/history?range=bad")).status).toBe(400);
  });

  it("keyset-paginates tied timestamps with opaque cursors and rejects bad input", async () => {
    const first = UserTradesSchema.parse(await (await get("trades?limit=1")).json());
    expect(first.trades).toHaveLength(1);
    expect(typeof first.nextCursor).toBe("string");
    const second = UserTradesSchema.parse(
      await (await get(`trades?limit=1&cursor=${first.nextCursor}`)).json(),
    );
    expect(second.trades).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(first.trades[0]!.id > second.trades[0]!.id).toBe(true);
    const all = [...first.trades, ...second.trades];
    expect(all.find((trade) => trade.side === "buy")!.realizedPnlUsd).toBeNull();
    expect(all.find((trade) => trade.side === "sell")).toMatchObject({
      mint,
      symbol: "TEST",
      tokenAmount: 4,
      priceUsd: 15,
      valueUsd: 60,
      realizedPnlUsd: 20,
      time: buy.timestamp,
    });
    for (const cursor of [
      "garbage",
      "",
      Buffer.from(JSON.stringify({ executedAt: "bad", id: "bad" })).toString("base64url"),
    ]) {
      expect((await get(`trades?cursor=${cursor}`)).status).toBe(400);
    }
    expect((await get("trades?limit=0")).status).toBe(400);
    expect((await get("trades?limit=101")).status).toBe(400);
  });

  it("requires auth on all portfolio endpoints", async () => {
    for (const path of ["portfolio", "portfolio/history", "trades"]) {
      expect((await app.request(`/v1/me/${path}`)).status).toBe(401);
    }
  });

  it("snapshot sweep writes and upserts today's UTC equity", async () => {
    const processor = createPortfolioSnapshotProcessor(repository, portfolio, () => FIXED_NOW);
    await processor({} as Job);
    await processor({} as Job);
    const rows = await db
      .select()
      .from(schema.portfolioSnapshots)
      .where(eq(schema.portfolioSnapshots.userId, userIds[0]!));
    const today = rows.filter((row) => row.day === "2026-01-01");
    expect(today).toHaveLength(1);
    expect(Number(today[0]!.valueUsd)).toBe(140);
    expect(Number(today[0]!.positionsValueUsd)).toBe(90);
  });

  it("snapshots cash-only linked wallets with no positions", async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ privyDid: `did:privy:cash-${suffix}` })
      .returning();
    userIds.push(user!.id);
    await db.insert(schema.wallets).values({
      userId: user!.id,
      address: `cash-${suffix}`,
      chainType: "solana",
      walletClientType: "privy",
    });
    expect(await repository.getPositions(user!.id)).toEqual([]);
    const users = await repository.usersForSnapshots();
    expect(users.filter((row) => row.userId === user!.id)).toHaveLength(1);
    expect(users.filter((row) => row.userId === userIds[0])).toHaveLength(1);
    const processor = createPortfolioSnapshotProcessor(repository, portfolio, () => FIXED_NOW);
    await processor({} as Job);
    await processor({} as Job);
    expect(await repository.history(user!.id)).toMatchObject([
      { day: "2026-01-01", valueUsd: "50.000000000000000000" },
    ]);
  });
});
