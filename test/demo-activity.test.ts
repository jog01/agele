import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { like } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { seedDemoActivity } from "../src/db/seed-social";
import { trades } from "../src/models";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import { PgPositionLeaderboardRepository } from "../src/repositories/position-leaderboard.repository";
import { PositionLeaderboardService } from "../src/services/position-leaderboard.service";
import { socialDemoFixture } from "./helpers";

const DAY = 86_400_000;
const now = Date.now();

describe("seedDemoActivity on a demo store seeded ten days ago", () => {
  const fixture = socialDemoFixture(now - 10 * DAY);
  const db = getDb();
  let added = 0;
  beforeAll(async () => {
    await fixture.setUp();
    added = await seedDemoActivity(db, now);
  });
  afterAll(fixture.tearDown);
  const board = (at: number) =>
    new PositionLeaderboardService(
      new PgPositionLeaderboardRepository(db),
      new InMemoryFollowRepository(),
      () => at,
    );

  it("fills the 24h and 7d Positions windows with closed seeded positions", async () => {
    expect(added).toBeGreaterThan(150);
    const service = board(now);
    const day = await service.leaderboard({ window: "24h", limit: 100 });
    const week = await service.leaderboard({ window: "7d", limit: 100 });
    expect(day.entries.length).toBeGreaterThanOrEqual(10);
    expect(week.entries.length).toBeGreaterThan(day.entries.length);
    for (const entry of [...day.entries, ...week.entries]) {
      expect(entry.source).toBe("demo");
      expect(entry.closedAt * 1000).toBeLessThanOrEqual(now);
      expect(entry.token.imageUrl).toStartWith("https://");
      expect(entry.avgEntryMarketCapUsd).toBeGreaterThan(0);
      expect(entry.holdSeconds).toBeGreaterThanOrEqual(300);
      expect(entry.holdSeconds).toBeLessThanOrEqual(12 * 3600);
    }
    expect(day.entries.every((entry) => entry.closedAt * 1000 >= now - DAY)).toBe(true);
    expect(week.entries.some((entry) => entry.thesis)).toBe(true);
    expect(week.entries.some((entry) => !entry.thesis)).toBe(true);
    for (const invested of ["lt100", "100-1k", "1k-10k", "10k-100k", "gt100k"] as const)
      expect((await service.leaderboard({ window: "7d", invested, limit: 1 })).entries).toHaveLength(1);
  });

  it("only adds new slots on rerun and keeps rolling forward", async () => {
    expect(await seedDemoActivity(db, now)).toBe(0);
    const before = (await db.select().from(trades).where(like(trades.signature, "demo:%:roll:%"))).length;
    const later = now + DAY;
    expect(await seedDemoActivity(db, later)).toBeGreaterThan(0);
    const after = (await db.select().from(trades).where(like(trades.signature, "demo:%:roll:%"))).length;
    expect(after - before).toBeGreaterThanOrEqual(20);
    const day = await board(later).leaderboard({ window: "24h", limit: 100 });
    expect(day.entries.length).toBeGreaterThanOrEqual(10);
    expect(day.entries.every((entry) => entry.closedAt * 1000 >= now)).toBe(true);
  });
});
