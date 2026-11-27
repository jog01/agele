import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getDb } from "../src/db/client";
import { seedSocialDemo } from "../src/db/seed-social";
import { unauthorized } from "../src/lib/errors";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import type { FeedPage, LeaderboardEntryDto } from "../src/schemas/social";
import { encodeCursor } from "../src/services/social/cursor";
import type { UserService } from "../src/services/user.service";
import { SOL, socialDemoFixture, testApp } from "./helpers";

const headers = { authorization: "Bearer good" };
const secondary = "11111111111111111111111111111111";
const viewerId = "1fb40aaa-5ec0-4c2e-9b27-8f7e0d7a10ac";
const fixture = socialDemoFixture();
beforeAll(fixture.setUp);
afterAll(fixture.tearDown);
function setup() {
  const follows = new InMemoryFollowRepository();
  const app = testApp({
    follows,
    auth: {
      verify: async (token) => {
        if (token !== "good") throw unauthorized("Invalid access token");
        return { privyDid: "did:privy:test", sessionId: "s" };
      },
    },
    users: {
      ensureUser: async () => ({ id: viewerId, walletAddress: SOL, wallets: [{ address: secondary }] }),
    } as unknown as UserService,
  });
  return { app, follows };
}
async function page(app: ReturnType<typeof testApp>, query = "", authenticated = false) {
  const res = await app.request(`/v1/feed${query}`, { headers: authenticated ? headers : undefined });
  expect(res.status).toBe(200);
  return (await res.json()) as FeedPage;
}

describe("feed", () => {
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
        } else {
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
    ]) {
      expect((await app.request(`/v1/feed?${query}`)).status).toBe(400);
    }
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
