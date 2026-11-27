import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../src/config/env";
import { createTradeIndexProcessor } from "../src/jobs/processors/trade-index";
import * as schema from "../src/models";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { SOL_MINT, USDC_MINT } from "../src/services/helius-parser";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TradeIndexer } from "../src/services/trade-indexer";
import { buy, failed, MINT, sell, transfer, WALLET } from "./fixtures/helius";
import { FIXED_NOW, testApp } from "./helpers";

describe("Helius webhook database integration", () => {
  const sql = postgres(env.DATABASE_URL, { max: 3 });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  const market = new MockMarketDataProvider(() => FIXED_NOW);
  const indexer = new TradeIndexer(new PgTradeRepository(db), {
    name: "test",
    listTrending: (...args) => market.listTrending(...args),
    getCandles: (...args) => market.getCandles(...args),
    getHistoricalPriceUsd: async (mint, minute) =>
      mint === SOL_MINT && minute === sell.timestamp ? 100 : null,
    getRecentTrades: (...args) => market.getRecentTrades(...args),
    getHolders: (...args) => market.getHolders(...args),
    getToken: async (mint) =>
      mint === SOL_MINT ? { ...(await market.getToken(SOL_MINT))!, priceUsd: 400 } : null,
  });
  const queued: (typeof buy)[] = [];
  const app = testApp({
    tradeQueue: {
      enqueue: async (transactions) => {
        queued.push(...transactions);
        return { queued: transactions.length };
      },
    },
  });
  const processTrade = createTradeIndexProcessor(indexer);
  const originalSecret = env.HELIUS_WEBHOOK_SECRET;
  const suffix = crypto.randomUUID();
  const address = `${WALLET}-${suffix}`;
  const mint = `${MINT}-${suffix}`;
  const deferredMint = `${mint}-deferred`;
  const independentMint = `${mint}-independent`;
  let userId: string;
  const fixture = (tx: typeof buy) => ({
    ...tx,
    signature: `${tx.signature}-${suffix}`,
    feePayer: address,
    accountData: tx.accountData.map((account) => ({
      ...account,
      account: account.account === WALLET ? address : account.account,
      tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
        ...change,
        userAccount: address,
        mint: change.mint === MINT ? mint : change.mint,
      })),
    })),
  });
  const deliver = (body: unknown, secret = "test-webhook-secret") =>
    app.request("/v1/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: secret },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    env.HELIUS_WEBHOOK_SECRET = "test-webhook-secret";
    const [user] = await db
      .insert(schema.users)
      .values({ privyDid: `did:privy:${suffix}` })
      .returning();
    userId = user!.id;
    await db
      .insert(schema.wallets)
      .values({ userId, address, chainType: "solana", walletClientType: "privy" });
  });
  afterAll(async () => {
    env.HELIUS_WEBHOOK_SECRET = originalSecret;
    if (userId) {
      await db.delete(schema.trades).where(eq(schema.trades.userId, userId));
      await db.delete(schema.positions).where(eq(schema.positions.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      await db
        .delete(schema.tokens)
        .where(inArray(schema.tokens.mint, [mint, deferredMint, independentMint]));
    }
    await sql.end();
  });

  it("requires an exact configured authorization secret", async () => {
    expect((await deliver([], "wrong")).status).toBe(401);
    expect((await deliver([], "")).status).toBe(401);
    env.HELIUS_WEBHOOK_SECRET = undefined;
    try {
      expect((await deliver([])).status).toBe(503);
    } finally {
      env.HELIUS_WEBHOOK_SECRET = "test-webhook-secret";
    }
  });
  it("accepts empty payloads and rejects malformed ones", async () => {
    const empty = await deliver([]);
    expect(empty.status).toBe(202);
    expect(await empty.json()).toEqual({ queued: 0 });
    expect((await deliver([{}])).status).toBe(400);
  });

  it("does not acknowledge enqueue failures", async () => {
    const unavailable = testApp({
      tradeQueue: {
        enqueue: async () => {
          throw new Error("queue unavailable");
        },
      },
    });
    const response = await unavailable.request("/v1/webhooks/helius", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "test-webhook-secret" },
      body: JSON.stringify([buy]),
    });
    expect(response.status).toBe(500);
  });
  it("indexes a buy and partial sell once and updates average-cost realized PnL", async () => {
    const events: string[] = [];
    const off = indexer.onTrade((trade) => {
      events.push(trade.signature);
    });
    try {
      const response = await deliver([fixture(buy), fixture(sell), fixture(transfer), fixture(failed)]);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ queued: 4 });
      expect(queued).toHaveLength(4);
      await processTrade({ data: queued.splice(0) });
      const [position] = await db.select().from(schema.positions).where(eq(schema.positions.userId, userId));
      expect(Number(position!.quantity)).toBe(6);
      expect(Number(position!.costBasisUsd)).toBe(60);
      expect(Number(position!.realizedPnlUsd)).toBe(20);
      const stored = await db.select().from(schema.trades).where(eq(schema.trades.userId, userId));
      expect(stored).toHaveLength(2);
      expect(Number(stored.find((trade) => trade.side === "sell")!.realizedPnlUsd)).toBe(20);
      expect(Number(stored.find((trade) => trade.side === "sell")!.solPriceUsd)).toBe(100);
      expect(stored.find((trade) => trade.side === "buy")!.solPriceUsd).toBeNull();
      const duplicates = await Promise.all([
        deliver([fixture(buy), fixture(sell)]),
        deliver([fixture(buy), fixture(sell)]),
      ]);
      for (const duplicate of duplicates) {
        expect(await duplicate.json()).toEqual({ queued: 2 });
      }
      await processTrade({ data: queued.splice(0) });
      expect(await db.select().from(schema.positions).where(eq(schema.positions.userId, userId))).toEqual([
        position!,
      ]);
      expect(events).toHaveLength(2);
      expect(await db.select().from(schema.trades).where(eq(schema.trades.userId, userId))).toEqual(stored);
      const [token] = await db.select().from(schema.tokens).where(eq(schema.tokens.mint, mint));
      expect(token!.symbol).toBe(mint.slice(0, 8));
    } finally {
      off();
    }
  });

  it("does not record a sale ahead of a deferred buy in another batch", async () => {
    let historicalPrice: number | null = null;
    const worker = () => {
      const market = new MockMarketDataProvider();
      market.getHistoricalPriceUsd = async () => historicalPrice;
      return createTradeIndexProcessor(new TradeIndexer(new PgTradeRepository(db), market));
    };
    const solBuy = (token: string, offset: number) => {
      const tx = fixture(buy);
      return {
        ...tx,
        signature: `${tx.signature}-sol-buy-${offset}`,
        timestamp: tx.timestamp + offset,
        accountData: tx.accountData.map((account) => ({
          ...account,
          tokenBalanceChanges: account.tokenBalanceChanges.map((change) =>
            change.mint === USDC_MINT
              ? { ...change, mint: SOL_MINT, rawTokenAmount: { tokenAmount: "-1000000000", decimals: 9 } }
              : { ...change, mint: token },
          ),
        })),
      };
    };
    const stableSell = fixture(buy);
    stableSell.signature += "-stable-sell";
    stableSell.timestamp += 60;
    stableSell.accountData[1]!.tokenBalanceChanges[0] = {
      userAccount: address,
      mint: deferredMint,
      rawTokenAmount: { tokenAmount: "-4000000", decimals: 6 },
    };
    stableSell.accountData[1]!.tokenBalanceChanges[1]!.rawTokenAmount = {
      tokenAmount: "60000000",
      decimals: 6,
    };
    const stableBuy = fixture(buy);
    stableBuy.signature += "-independent-buy";
    stableBuy.timestamp += 61;
    stableBuy.accountData[1]!.tokenBalanceChanges[0]!.mint = independentMint;
    const first = { data: [solBuy(deferredMint, 1)] };
    const second = { data: [solBuy(independentMint, 59), stableSell, stableBuy] };
    const unrelated = {
      data: [
        {
          ...stableBuy,
          signature: `${stableBuy.signature}-other`,
          timestamp: stableBuy.timestamp + 1,
          accountData: fixture(buy).accountData,
        },
      ],
    };
    await expect(worker()(first)).rejects.toMatchObject({ code: "price_unavailable" });
    await expect(worker()(second)).rejects.toMatchObject({ code: "price_unavailable" });
    await worker()(unrelated);
    const forMint = () =>
      db
        .select()
        .from(schema.positions)
        .where(and(eq(schema.positions.userId, userId), eq(schema.positions.mint, deferredMint)));
    expect(await forMint()).toEqual([]);
    historicalPrice = 100;
    await worker()(first);
    await worker()(second);
    const [position] = await forMint();
    expect(Number(position!.quantity)).toBe(6);
    expect(Number(position!.costBasisUsd)).toBe(60);
    expect(Number(position!.realizedPnlUsd)).toBe(20);
  });
});
