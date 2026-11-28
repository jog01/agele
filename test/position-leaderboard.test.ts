import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { unauthorized } from "../src/lib/errors";
import type { Trade } from "../src/models";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import type { PositionLeaderboardRepository } from "../src/repositories/position-leaderboard.repository";
import { PositionsLeaderboardSchema } from "../src/schemas/social";
import {
  PositionLeaderboardService,
  type PositionsLeaderboardFilter,
} from "../src/services/position-leaderboard.service";
import type { UserService } from "../src/services/user.service";
import { FIXED_NOW, SOL, socialDemoFixture, testApp } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const headers = { authorization: "Bearer good" };

describe("GET /v1/leaderboard/positions on the seeded demo store", () => {
  const follows = new InMemoryFollowRepository();
  const app = testApp({
    follows,
    auth: {
      verify: async (token) => {
        if (token !== "good") throw unauthorized("Invalid access token");
        return { privyDid: "did:privy:positions", sessionId: "s" };
      },
    },
    users: {
      ensureUser: async () => ({ id: "positions-viewer", walletAddress: SOL, wallets: [] }),
    } as unknown as UserService,
  });
  const fixture = socialDemoFixture();
  beforeAll(fixture.setUp);
  afterAll(fixture.tearDown);
  const get = async (query: string, authenticated = false) => {
    const res = await app.request(`/v1/leaderboard/positions${query}`, {
      headers: authenticated ? headers : undefined,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-data-source")).toBe("demo");
    return PositionsLeaderboardSchema.parse(await res.json());
  };

  it("ranks seeded closed positions by realized PnL with trader, token, thesis, entry cap and invested", async () => {
    const body = await get("?window=all&limit=100");
    expect(body.window).toBe("all");
    expect(body.nextCursor).toBeNull();
    expect(body.entries).toHaveLength(24);
    for (const [index, entry] of body.entries.entries()) {
      expect(entry.rank).toBe(index + 1);
      if (index) expect(body.entries[index - 1]!.realizedPnlUsd).toBeGreaterThanOrEqual(entry.realizedPnlUsd);
      expect(entry.source).toBe("demo");
      expect(entry).not.toHaveProperty("isFollowing");
      expect(entry.trader.handle).toBeString();
      expect(entry.trader.avatarUrl).toStartWith("https://");
      expect(entry.token.symbol).toBeString();
      expect(entry.token.imageUrl).toStartWith("https://");
      expect(entry.avgEntryMarketCapUsd).toBeGreaterThan(0);
      expect(entry.totalInvestedUsd).toBeGreaterThan(0);
      expect(entry.pnlPct).toBeCloseTo((100 * entry.realizedPnlUsd) / entry.totalInvestedUsd, 6);
      expect(entry.holdSeconds).toBe(entry.closedAt - entry.openedAt);
      expect(entry.thesis?.body).toStartWith(entry.token.symbol);
    }
  });

  it("pages with a keyset cursor and keeps ranks across pages", async () => {
    const all = (await get("?window=all&limit=100")).entries;
    const ranks: number[] = [];
    let page = await get("?window=all&limit=7");
    for (;;) {
      ranks.push(...page.entries.map((entry) => entry.rank));
      expect(page.entries).toEqual(all.slice(ranks.length - page.entries.length, ranks.length));
      if (!page.nextCursor) break;
      page = await get(`?window=all&limit=7&cursor=${page.nextCursor}`);
    }
    expect(ranks).toEqual(all.map((_, index) => index + 1));
  });

  it("fills every invested bucket and hold-time range from the seed", async () => {
    for (const [bucket, low, high] of [
      ["lt100", 0, 100],
      ["100-1k", 100, 1_000],
      ["1k-10k", 1_000, 10_000],
      ["10k-100k", 10_000, 100_000],
      ["gt100k", 100_000, Number.POSITIVE_INFINITY],
    ] as const) {
      const { entries } = await get(`?window=all&invested=${bucket}&limit=100`);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.totalInvestedUsd >= low && entry.totalInvestedUsd < high)).toBe(
        true,
      );
      expect(entries.map((entry) => entry.rank)).toEqual(entries.map((_, index) => index + 1));
    }
    const short = (await get("?window=all&maxHoldSeconds=3600&limit=100")).entries;
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((entry) => entry.holdSeconds <= 3600)).toBe(true);
    const quarter = 90 * 86_400;
    const long = (await get(`?window=all&minHoldSeconds=${quarter}&limit=100`)).entries;
    expect(long.length).toBeGreaterThan(0);
    expect(long.every((entry) => entry.holdSeconds >= quarter)).toBe(true);
  });

  it("keeps positions closed in the window", async () => {
    const now = Date.now() / 1000;
    for (const [window, span] of [
      ["24h", 86_400],
      ["7d", 7 * 86_400],
    ] as const) {
      const { entries } = await get(`?window=${window}&limit=100`);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.length).toBeLessThan(24);
      expect(entries.every((entry) => entry.closedAt >= now - span - 5)).toBe(true);
    }
    expect((await get("?window=30d&limit=100")).entries).toHaveLength(24);
    const first = await get("?limit=1");
    expect(first.window).toBe("24h");
    expect(first.entries).toHaveLength(1);
  });

  it("adds follow state only for signed-in viewers", async () => {
    const [top] = (await get("?window=all&limit=1")).entries;
    await follows.follow("positions-viewer", top!.trader.wallet);
    const authed = await get("?window=all&limit=100", true);
    expect(authed.entries.filter((entry) => entry.isFollowing)).toHaveLength(2);
    for (const entry of authed.entries)
      expect(entry.isFollowing).toBe(entry.trader.wallet === top!.trader.wallet);
  });

  it("rejects invalid filters", async () => {
    for (const query of [
      "window=1y",
      "invested=huge",
      "minHoldSeconds=-1",
      "maxHoldSeconds=abc",
      "minHoldSeconds=10&maxHoldSeconds=5",
      "invested=all",
      "cursor=garbage",
      "limit=0",
      "limit=101",
    ])
      expect((await app.request(`/v1/leaderboard/positions?${query}`)).status).toBe(400);
  });

  it("documents the route in the OpenAPI document", async () => {
    const document = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, { get?: { parameters?: { name: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };
    expect(
      document.paths["/v1/leaderboard/positions"]?.get?.parameters?.map((parameter) => parameter.name).sort(),
    ).toEqual(["cursor", "invested", "limit", "maxHoldSeconds", "minHoldSeconds", "window"]);
    expect(document.components.schemas).toHaveProperty("PositionsLeaderboardEntry");
  });
});

describe("PositionLeaderboardService", () => {
  const MINT = "Mint111111111111111111111111111111111111111";
  const trade = (userId: string, side: Trade["side"], usd: number, at: number, cap?: number): Trade => ({
    id: crypto.randomUUID(),
    userId,
    mint: MINT,
    walletAddress: `${userId}-wallet`,
    side,
    tokenAmount: "10",
    priceUsd: String(usd / 10),
    quoteAmountUsd: String(usd),
    solPriceUsd: null,
    marketCapUsd: cap === undefined ? null : String(cap),
    realizedPnlUsd: null,
    signature: crypto.randomUUID(),
    executedAt: new Date(at),
    createdAt: new Date(at),
  });
  const closed = (userId: string, invested: number, exit: number, openedAgo: number, closedAgo: number) => [
    trade(userId, "buy", invested, FIXED_NOW - openedAgo, 1_000_000),
    trade(userId, "sell", exit, FIXED_NOW - closedAgo),
  ];

  function setup(fills: Trade[]) {
    let now = FIXED_NOW;
    let reads = 0;
    const repository: PositionLeaderboardRepository = {
      getFills: async (since) => {
        reads++;
        const active = new Set(
          fills
            .filter((fill) => !since || fill.executedAt >= since)
            .map((fill) => `${fill.userId}:${fill.mint}`),
        );
        return fills
          .filter((fill) => active.has(`${fill.userId}:${fill.mint}`))
          .toSorted((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
      },
      getTraders: async (ids) =>
        ids.map((id) => ({
          id,
          wallet: `${id}-wallet`,
          handle: id === "ghost" ? null : id,
          displayName: null,
          avatarUrl: null,
          demo: false,
        })),
      getTheses: async (ids) =>
        ids.slice(0, 1).map((positionId) => ({
          positionId,
          id: crypto.randomUUID(),
          body: "why",
          createdAt: new Date(FIXED_NOW),
        })),
      getTokens: async (mints) =>
        mints.map((mint) => ({ mint, symbol: "TKN", name: "Token", imageUrl: null })),
    };
    const follows = new InMemoryFollowRepository();
    const service = new PositionLeaderboardService(repository, follows, () => now, 1000);
    return {
      service,
      follows,
      reads: () => reads,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const query: PositionsLeaderboardFilter = { window: "all", limit: 25 };

  it("ranks only closed positions by realized PnL", async () => {
    const { service } = setup([
      trade("open", "buy", 100, FIXED_NOW - DAY),
      ...closed("alice", 100, 90, 2 * DAY, DAY),
      trade("bob", "buy", 20, FIXED_NOW - 5 * HOUR, 2_000_000),
      trade("bob", "buy", 30, FIXED_NOW - 4 * HOUR, 4_000_000),
      { ...trade("bob", "sell", 80, FIXED_NOW - 2 * HOUR), tokenAmount: "20" },
    ]);
    const { entries, nextCursor } = await service.leaderboard(query);
    expect(nextCursor).toBeNull();
    expect(entries.map((entry) => [entry.rank, entry.trader.handle, entry.realizedPnlUsd])).toEqual([
      [1, "bob", 30],
      [2, "alice", -10],
    ]);
    expect(entries[0]).toMatchObject({ totalInvestedUsd: 50, pnlPct: 60, holdSeconds: 3 * 3600 });
    expect(entries[0]!.avgEntryMarketCapUsd).toBe(3_000_000);
    expect(entries[1]!.pnlPct).toBe(-10);
    expect(entries.filter((entry) => entry.thesis)).toHaveLength(1);
  });

  it("filters by close window, lower-inclusive invested bucket and inclusive hold bounds", async () => {
    const { service } = setup([
      ...closed("old", 50_000, 60_000, 40 * DAY, 35 * DAY),
      ...closed("small", 99.99, 120, 2 * HOUR, HOUR),
      ...closed("edge", 100, 110, 3 * HOUR, HOUR),
      ...closed("ghost", 1_000, 1_000, 20 * DAY, 3 * DAY),
    ]);
    const handles = async (filter: Partial<PositionsLeaderboardFilter>) =>
      (await service.leaderboard({ ...query, ...filter })).entries.map((entry) => entry.trader.handle);
    expect(await handles({})).toEqual(["old", "small", "edge", "ghost-wa"]);
    expect(await handles({ window: "30d" })).toEqual(["small", "edge", "ghost-wa"]);
    expect(await handles({ window: "24h" })).toEqual(["small", "edge"]);
    expect(await handles({ invested: "lt100" })).toEqual(["small"]);
    expect(await handles({ invested: "100-1k" })).toEqual(["edge"]);
    expect(await handles({ invested: "1k-10k" })).toEqual(["ghost-wa"]);
    expect(await handles({ invested: "10k-100k" })).toEqual(["old"]);
    expect(await handles({ maxHoldSeconds: 3600 })).toEqual(["small"]);
    expect(await handles({ minHoldSeconds: 7200, maxHoldSeconds: 7200 })).toEqual(["edge"]);
  });

  it("pages after the cursor's PnL and position and rejects bad cursors", async () => {
    const { service } = setup([
      ...closed("a", 100, 150, 2 * DAY, DAY),
      ...closed("b", 100, 120, 2 * DAY, DAY),
      ...closed("c", 100, 120, 2 * DAY, DAY),
    ]);
    const first = await service.leaderboard({ ...query, limit: 2 });
    expect(first.entries.map((entry) => entry.rank)).toEqual([1, 2]);
    const second = await service.leaderboard({ ...query, limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ nextCursor: null, entries: [{ rank: 3, realizedPnlUsd: 20 }] });
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.positionId)).size).toBe(3);
    await expect(service.leaderboard({ ...query, cursor: "e30" })).rejects.toThrow(
      "Invalid leaderboard cursor",
    );
  });

  it("caches each window for the TTL and marks followed traders", async () => {
    const { service, follows, reads, advance } = setup(closed("alice", 10, 12, HOUR, 60_000));
    await Promise.all([service.leaderboard(query), service.leaderboard(query)]);
    expect(reads()).toBe(1);
    await follows.follow("viewer", "alice-wallet");
    expect((await service.leaderboard(query, "viewer")).entries[0]!.isFollowing).toBe(true);
    expect((await service.leaderboard(query, "other")).entries[0]!.isFollowing).toBe(false);
    expect(reads()).toBe(1);
    await service.leaderboard({ ...query, window: "24h" });
    expect(reads()).toBe(2);
    advance(1000);
    await service.leaderboard(query);
    expect(reads()).toBe(3);
  });
});
