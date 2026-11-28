import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { unauthorized } from "../src/lib/errors";
import { users } from "../src/models";
import { PgFollowRepository } from "../src/repositories/follow.repository";
import { TokenHolderListSchema } from "../src/schemas/token-activity";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import type { UserService } from "../src/services/user.service";
import { FIXED_NOW, socialDemoFixture, testApp } from "./helpers";

const fixture = socialDemoFixture();
const seeded = (index: number) => `ade10000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const mint = MockMarketDataProvider.mints[0]!;
const market = new MockMarketDataProvider(() => FIXED_NOW);
let viewerId = seeded(2);
let handles = new Map<string, string>();
const app = testApp({
  market,
  follows: new PgFollowRepository(getDb()),
  auth: {
    verify: async (token) => {
      if (token !== "good") throw unauthorized("Invalid access token");
      return { privyDid: "did:privy:holders", sessionId: "s" };
    },
  },
  users: { ensureUser: async () => ({ id: viewerId }) } as unknown as UserService,
});
const signedIn = { authorization: "Bearer good" };
const list = async (query: string, headers: Record<string, string> = {}) => {
  const response = await app.request(`/v1/tokens/${mint}/holders${query}`, { headers });
  expect(response.status).toBe(200);
  return { response, body: TokenHolderListSchema.parse(await response.json()) };
};
const handlesOf = (body: { holders: { trader: { handle: string | null } | null }[] }) =>
  body.holders.map((holder) => holder.trader?.handle);

beforeAll(async () => {
  await fixture.setUp();
  const rows = await getDb()
    .select({ id: users.id, handle: users.handle, wallet: users.walletAddress })
    .from(users)
    .where(inArray(users.id, [0, 4, 8].map(seeded)));
  handles = new Map(rows.map((row) => [row.id, row.handle!]));
});
afterAll(fixture.tearDown);

describe("GET /v1/tokens/{mint}/holders scope=traders", () => {
  it("lists seeded traders with open positions, theses and trader metadata", async () => {
    const { response, body } = await list("?scope=traders");
    expect(response.headers.get("X-Data-Source")).toBe("indexed");
    expect(body.scope).toBe("traders");
    for (const index of [0, 4, 8]) expect(handlesOf(body)).toContain(handles.get(seeded(index)));
    expect(body.holders.map((holder) => holder.rank)).toEqual(body.holders.map((_, index) => index + 1));
    const amounts = body.holders.map((holder) => holder.amount);
    expect(amounts).toEqual(amounts.toSorted((a, b) => b - a));

    const northstar = body.holders.find((holder) => holder.trader?.handle === handles.get(seeded(0)))!;
    expect(northstar.trader).toMatchObject({
      source: "demo",
      avatarUrl: expect.stringContaining("https://"),
    });
    expect(northstar.trader!.avgHoldSeconds).toBeGreaterThan(0);
    expect(northstar.valueUsd).toBeGreaterThan(0);
    expect(northstar.pctSupply).toBeGreaterThan(0);
    expect(northstar.position).toMatchObject({
      investedUsd: expect.any(Number),
      avgEntryMarketCapUsd: expect.any(Number),
    });
    expect(northstar.position!.pnlUsd).toBeCloseTo(
      northstar.position!.realizedPnlUsd + northstar.position!.unrealizedPnlUsd,
    );
    expect(northstar.latestThesis).toMatchObject({
      thesisId: "ade10000-0000-4000-8001-000000000000",
      postId: "ade10000-0000-4000-8004-000000000000",
      likeCount: 3,
      replyCount: 1,
    });
    expect(northstar.latestThesis!.body.length).toBeGreaterThan(0);
    expect(northstar.isFollowed).toBe(false);

    const holderOnly = body.holders.find((holder) => holder.trader?.handle === handles.get(seeded(4)))!;
    expect(holderOnly.latestThesis).toBeNull();
    expect(holderOnly.position).not.toBeNull();
  });

  it("filters to holders with a thesis before the limit", async () => {
    const { body } = await list("?scope=traders&thesisOnly=true");
    expect(body.holders.length).toBeGreaterThanOrEqual(2);
    expect(body.holders.every((holder) => holder.latestThesis)).toBe(true);
    expect(handlesOf(body)).not.toContain(handles.get(seeded(4)));
    const { body: unfiltered } = await list("?scope=traders");
    const ranks = new Map(unfiltered.holders.map((holder) => [holder.trader?.handle, holder.rank]));
    for (const holder of body.holders) expect(holder.rank).toBe(ranks.get(holder.trader?.handle)!);
    const { body: limited } = await list("?scope=traders&thesisOnly=true&limit=1");
    expect(limited.holders).toHaveLength(1);
    expect(limited.holders[0]!.latestThesis).not.toBeNull();
  });

  it("requires a viewer for followingOnly and keeps only followed holders", async () => {
    const anonymous = await app.request(`/v1/tokens/${mint}/holders?scope=traders&followingOnly=true`);
    expect(anonymous.status).toBe(401);

    viewerId = seeded(2);
    const { body } = await list("?scope=traders&followingOnly=true", signedIn);
    expect(handlesOf(body)).toEqual([handles.get(seeded(4))]);
    expect(body.holders[0]!.isFollowed).toBe(true);
    const { body: none } = await list("?scope=traders&followingOnly=true&thesisOnly=true", signedIn);
    expect(none.holders).toEqual([]);

    viewerId = seeded(10);
    const { body: theses } = await list("?scope=traders&followingOnly=true&thesisOnly=true", signedIn);
    expect(handlesOf(theses)).toEqual([handles.get(seeded(0))]);
    const { body: all } = await list("?scope=traders", signedIn);
    const followed = all.holders.filter((holder) => holder.isFollowed).map((holder) => holder.trader?.handle);
    expect(followed).toEqual([handles.get(seeded(0))]);
  });

  it("drops holders below minValueUsd", async () => {
    const { body } = await list("?scope=traders");
    const threshold = Math.max(...body.holders.map((holder) => holder.valueUsd));
    const { body: filtered } = await list(`?scope=traders&minValueUsd=${threshold}`);
    expect(filtered.holders.length).toBeLessThan(body.holders.length);
    expect(filtered.holders.every((holder) => holder.valueUsd >= threshold)).toBe(true);
  });
});

describe("GET /v1/tokens/{mint}/holders scope=all", () => {
  it("keeps market holders and enriches wallets that belong to traders", async () => {
    const [northstar] = await getDb()
      .select({ wallet: users.walletAddress })
      .from(users)
      .where(inArray(users.id, [seeded(0)]));
    const original = market.getHolders.bind(market);
    market.getHolders = async (requested, limit) => {
      const snapshot = await original(requested, limit);
      return {
        ...snapshot,
        holders: snapshot.holders.map((holder) =>
          holder.rank === 3 ? { ...holder, wallet: northstar!.wallet! } : holder,
        ),
      };
    };
    try {
      viewerId = seeded(10);
      const { response, body } = await list("?limit=50", signedIn);
      expect(response.headers.get("X-Data-Source")).toBeNull();
      expect(body.scope).toBe("all");
      expect(body.holders.length).toBe(20);
      const enriched = body.holders.find((holder) => holder.rank === 3)!;
      expect(enriched.trader?.handle).toBe(handles.get(seeded(0)));
      expect(enriched.isFollowed).toBe(true);
      expect(enriched.latestThesis).not.toBeNull();
      const anonymous = body.holders.find((holder) => holder.rank === 1)!;
      expect(anonymous).toMatchObject({
        trader: null,
        position: null,
        latestThesis: null,
        isFollowed: false,
      });

      const { body: theses } = await list("?thesisOnly=true");
      expect(theses.holders.map((holder) => holder.rank)).toEqual([3]);
      expect(theses.holders[0]!.isFollowed).toBe(false);
    } finally {
      market.getHolders = original;
    }
  });

  it("validates limit and unknown tokens", async () => {
    expect((await app.request(`/v1/tokens/${mint}/holders?limit=51`)).status).toBe(400);
    const unknown = "1".repeat(32);
    expect((await app.request(`/v1/tokens/${unknown}/holders`)).status).toBe(404);
  });
});
