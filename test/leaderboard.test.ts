import { describe, expect, it } from "bun:test";
import type { Position, Trade } from "../src/models";
import type { LeaderboardRepository } from "../src/repositories/leaderboard.repository";
import { LeaderboardService } from "../src/services/leaderboard.service";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { MemoryLeaderboard } from "./fixtures/leaderboard-store";
import { FIXED_NOW, SOL } from "./helpers";

function setup() {
  let now = FIXED_NOW;
  const trades: Trade[] = [];
  const positions: Position[] = [];
  const market = new MockMarketDataProvider();
  const events: { topic: string; data: unknown }[] = [];
  const repository: LeaderboardRepository = {
    getTrades: async (since, userId) =>
      trades.filter((trade) => trade.executedAt >= since && (!userId || trade.userId === userId)),
    getPositions: async (userId) => positions.filter((position) => !userId || position.userId === userId),
    getUsers: async (ids) =>
      ids.map((id) => ({ id, wallet: `${id}-wallet-address`, handle: id === "alice" ? "Alice" : null })),
  };
  const store = new MemoryLeaderboard();
  const leaderboard = new LeaderboardService(
    repository,
    store,
    market,
    {
      publish: (topic, data) => {
        events.push({ topic, data });
      },
    },
    () => now,
  );
  const addTrade = (
    userId: string,
    side: "buy" | "sell",
    volume: string,
    realized: string | null,
    days = 0,
  ) => {
    trades.push({
      id: crypto.randomUUID(),
      userId,
      mint: SOL,
      side,
      tokenAmount: "1",
      priceUsd: volume,
      quoteAmountUsd: volume,
      realizedPnlUsd: realized,
      signature: crypto.randomUUID(),
      executedAt: new Date(FIXED_NOW - days * 86400000),
      createdAt: new Date(FIXED_NOW),
    });
  };
  return {
    leaderboard,
    store,
    positions,
    trades,
    events,
    market,
    addTrade,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("leaderboard math and ranking", () => {
  it.each([null, 0])("values open positions at cost when market price is %s", async (price) => {
    const test = setup();
    test.addTrade("alice", "buy", "100", null);
    const token = (await test.market.getToken(SOL))!;
    test.market.getToken = async () => (price === null ? null : { ...token, priceUsd: price });
    test.positions.push({
      userId: "alice",
      mint: SOL,
      quantity: "2",
      costBasisUsd: "100",
      realizedPnlUsd: "0",
      updatedAt: new Date(),
    });
    await test.leaderboard.rebuild();
    expect((await test.store.top("24h", 10))[0]!.pnlUsd).toBe(0);
  });
  it("combines window realized PnL with open unrealized PnL and sorts indexed users", async () => {
    const test = setup();
    test.addTrade("alice", "buy", "100", null);
    test.addTrade("alice", "sell", "60", "20");
    test.addTrade("alice", "sell", "20", "-5");
    test.addTrade("bob", "buy", "100", null);
    test.addTrade("bob", "sell", "80", "-20");
    test.addTrade("old", "buy", "120", null, 2);
    const token = (await test.market.getToken(SOL))!;
    test.market.getToken = async () => ({ ...token, priceUsd: 25 });
    test.positions.push(
      {
        userId: "alice",
        mint: SOL,
        quantity: "4",
        costBasisUsd: "60",
        realizedPnlUsd: "15",
        updatedAt: new Date(),
      },
      {
        userId: "untraded",
        mint: SOL,
        quantity: "100",
        costBasisUsd: "0",
        realizedPnlUsd: "0",
        updatedAt: new Date(),
      },
    );
    await test.leaderboard.rebuild();
    const ranked = await test.leaderboard.leaderboard("24h", 10);
    expect(ranked).toMatchObject([
      {
        rank: 1,
        wallet: "alice-wallet-address",
        handle: "Alice",
        pnlUsd: 55,
        volumeUsd: 180,
        trades: 3,
        winRatePct: 50,
      },
      {
        rank: 2,
        wallet: "bob-wallet-address",
        handle: "bob-wall",
        pnlUsd: -20,
        pnlPct: -20,
        volumeUsd: 180,
        trades: 2,
        winRatePct: 0,
      },
    ]);
    expect(ranked[0]!.pnlPct).toBeCloseTo(55);
    expect(await test.store.top("7d", 10)).toHaveLength(3);
    expect(test.events).toEqual(
      ["24h", "7d", "30d"].map((window) => ({
        topic: "leaderboard:global",
        data: { window, updatedAt: FIXED_NOW / 1000 },
      })),
    );
    expect(await test.leaderboard.leaderboard("24h", 1)).toHaveLength(1);
  });

  it("ages users out, handles zero buy volume and null pricing", async () => {
    const test = setup();
    test.addTrade("seller", "sell", "15", "5");
    test.market.getToken = async () => null;
    test.positions.push({
      userId: "seller",
      mint: SOL,
      quantity: "1",
      costBasisUsd: "10",
      realizedPnlUsd: "5",
      updatedAt: new Date(),
    });
    await test.leaderboard.updateUser("seller");
    expect(await test.store.top("24h", 10)).toEqual([
      { userId: "seller", pnlUsd: 5, pnlPct: 0, volumeUsd: 15, trades: 1, winRatePct: 100 },
    ]);
    test.setNow(FIXED_NOW + 2 * 86400000);
    await test.leaderboard.rebuild();
    expect(await test.store.top("24h", 10)).toEqual([]);
    expect(await test.store.top("7d", 10)).toHaveLength(1);
    test.setNow(FIXED_NOW + 31 * 86400000);
    await test.leaderboard.rebuild();
    expect(await test.store.top("30d", 10)).toEqual([]);
  });

  it("preserves the previous snapshot on pricing failure and can recover", async () => {
    const test = setup();
    test.addTrade("alice", "buy", "100", null);
    await test.leaderboard.rebuild();
    test.positions.push({
      userId: "alice",
      mint: SOL,
      quantity: "1",
      costBasisUsd: "100",
      realizedPnlUsd: "0",
      updatedAt: new Date(),
    });
    test.market.getToken = async () => {
      throw new Error("price unavailable");
    };
    await expect(test.leaderboard.rebuild()).rejects.toThrow("price unavailable");
    expect((await test.store.top("24h", 10))[0]!.pnlUsd).toBe(0);
    test.market.getToken = async () => null;
    await test.leaderboard.rebuild();
    expect(await test.store.top("24h", 10)).toHaveLength(1);
  });
});
