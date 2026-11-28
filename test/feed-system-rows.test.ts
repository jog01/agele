import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { inArray } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { chainCandles, chainEvents, chainTokens, chainTrades, users } from "../src/models";
import { PgSocialRepository } from "../src/repositories/social.repository";
import { type FeedItemDto, FeedSchema } from "../src/schemas/social";
import type { ChainEvent } from "../src/services/chain-ingest/events";
import { IngestService } from "../src/services/chain-ingest/service";
import { DemoChainSimulator, DemoSolUsdPrice, demoChainFacts } from "../src/services/chain-ingest/simulator";
import { decodeCursor } from "../src/services/social/cursor";
import { socialDemoFixture, testApp } from "./helpers";

const db = getDb();
const fixture = socialDemoFixture();
const start = Date.now() - 20 * 60 * 1000;
const ingested: ChainEvent[] = [];
const app = testApp();

async function feed(query: string) {
  const res = await app.request(`/v1/feed?${query}`);
  expect(res.status).toBe(200);
  return FeedSchema.parse(await res.json());
}

async function all(query: string, limit = 7) {
  const items: FeedItemDto[] = [];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof feed>> = await feed(
      `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

beforeAll(async () => {
  await fixture.setUp();
  const sink = new IngestService(db, { publish() {} }, new DemoSolUsdPrice(), demoChainFacts, () => start);
  const stop = new AbortController();
  await new DemoChainSimulator({ seed: 4004, now: () => start, historyHours: 2 }).run(
    {
      ingest: async (events) => {
        ingested.push(...events);
        await sink.ingest(events);
        if (events.some((event) => (event.blockTime ?? 0) >= Math.floor(start / 1000))) stop.abort();
      },
    },
    stop.signal,
  );
});

afterAll(async () => {
  const mints = [...new Set(ingested.map((event) => event.mint))];
  if (mints.length) {
    await db.delete(chainCandles).where(inArray(chainCandles.mint, mints));
    await db.delete(chainTrades).where(inArray(chainTrades.mint, mints));
    await db.delete(chainTokens).where(inArray(chainTokens.mint, mints));
    await db.delete(chainEvents).where(
      inArray(
        chainEvents.signature,
        ingested.map((event) => event.signature),
      ),
    );
  }
  await fixture.tearDown();
});

describe("feed system rows", () => {
  it("lists every demo launch as a new-listing row, newest first, across pages", async () => {
    const launches = ingested.filter((event) => event.kind === "TokenLaunched");
    const rows = (await all("types=new-listing")).filter((row) => launches.some((l) => l.mint === row.mint));
    expect(rows.length).toBe(launches.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({ kind: "new-listing", eventType: "new-listing", source: "demo" });
      if (row.kind !== "new-listing") throw new Error("unexpected row");
      expect(row.creator).toBeString();
      expect(row.venue).toBeString();
      const previous = rows[index - 1];
      if (previous) expect(previous.createdAt >= row.createdAt).toBe(true);
    }
  });

  it("derives price spikes from completed 15-minute candle windows", async () => {
    const spikes = await all("types=price-spike", 3);
    expect(spikes.length).toBeGreaterThan(0);
    for (const spike of spikes) {
      if (spike.kind !== "price-spike") throw new Error("unexpected row");
      expect(spike.priceChangePct).toBeGreaterThanOrEqual(25);
      expect(spike.volumeUsd).toBeGreaterThanOrEqual(1000);
      expect(spike.windowSeconds).toBe(900);
      expect(spike.createdAt % 900).toBe(0);
      expect(spike.createdAt * 1000).toBeLessThanOrEqual(Date.now());
    }
  });

  it("pages spikes past the scan window and only counts whole 15-minute windows", async () => {
    const page = async (repository: PgSocialRepository) => {
      const rows = [];
      let cursor: string | null = null;
      do {
        const batch: Awaited<ReturnType<PgSocialRepository["systemFeed"]>> = await repository.systemFeed({
          cursor: cursor ? decodeCursor(cursor) : undefined,
          limit: 2,
          types: ["price-spike"],
        });
        rows.push(...batch.items);
        cursor = batch.nextCursor;
      } while (cursor);
      return rows.map((row) => row.id);
    };
    const narrow = await page(new PgSocialRepository(db, "demo", 1200));
    const wide = await page(new PgSocialRepository(db, "demo", 30 * 24 * 3600));
    expect(wide.length).toBeGreaterThan(0);
    expect(narrow).toEqual(wide);
  });

  it("merges system and trader rows into one ordered stream without gaps or duplicates", async () => {
    const types = "types=bought,increased,new-listing,price-spike,milestone";
    const paged = await all(types, 4);
    const whole = await all(types, 100);
    expect(paged.map((row) => row.id)).toEqual(whole.map((row) => row.id));
    expect(new Set(paged.map((row) => row.kind))).toEqual(
      new Set(["trade", "new-listing", "price-spike", "milestone"]),
    );
    for (const [index, row] of paged.entries()) {
      const previous = paged[index - 1];
      if (previous)
        expect(
          previous.createdAt > row.createdAt ||
            (previous.createdAt === row.createdAt && previous.id > row.id),
        ).toBe(true);
    }
  });

  it("keeps system rows out of trader-scoped filters and applies the market cap range", async () => {
    const types = "types=new-listing,price-spike";
    expect((await feed(`${types}&minSizeUsd=1`)).items).toEqual([]);
    expect((await feed(`${types}&minPortfolioUsd=1`)).items).toEqual([]);
    expect((await feed(`${types}&minPriceSinceFirstBuyPct=0`)).items).toEqual([]);
    const listings = await all(types, 100);
    const caps = listings.map((row) => row.marketCapUsd).filter((cap): cap is number => cap !== null);
    expect(caps.length).toBeGreaterThan(0);
    const floor = caps.sort((a, b) => a - b)[Math.floor(caps.length / 2)]!;
    const capped = await all(`${types}&minMarketCapUsd=${floor}`, 100);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(listings.length);
    expect(capped.every((row) => row.marketCapUsd !== null && row.marketCapUsd >= floor)).toBe(true);
    const ceiling = await all(`${types}&maxMarketCapUsd=${floor}`, 100);
    expect(ceiling.every((row) => row.marketCapUsd !== null && row.marketCapUsd <= floor)).toBe(true);
  });
});

describe("feed trader rows", () => {
  it("marks buys into an open position as increased and keeps the opening buy as bought", async () => {
    const trades = (await all("types=bought,increased", 100)).filter((row) => row.kind === "trade");
    expect(new Set(trades.map((row) => row.eventType))).toEqual(new Set(["bought", "increased"]));
    const byPosition = Map.groupBy(trades, (row) => (row.kind === "trade" ? row.positionId : null));
    for (const [positionId, rows] of byPosition) {
      expect(positionId).toBeString();
      expect(rows.filter((row) => row.eventType === "bought").length).toBeLessThanOrEqual(1);
      expect(rows.at(-1)!.eventType).toBe(rows.length === 1 ? rows[0]!.eventType : "bought");
    }
    expect((await all("types=increased", 100)).every((row) => row.eventType === "increased")).toBe(true);
  });

  it("links milestones to their position and names multi-user members and new-trader bios", async () => {
    const [milestone] = (await feed("types=milestone&limit=1")).items;
    expect(milestone).toMatchObject({ kind: "milestone", positionId: expect.any(String) });
    const [group] = (await feed("types=multi-user&limit=1")).items;
    if (group?.kind !== "multi-user") throw new Error("missing multi-user row");
    expect(group.members.length).toBe(Math.min(group.traderCount, 5));
    expect(new Set(group.members.map((member) => member.wallet)).size).toBe(group.members.length);
    expect(group.members.map((member) => member.wallet)).toContain(group.wallet);
    const [newcomer] = (await feed("types=new-trader&limit=1")).items;
    if (newcomer?.kind !== "new-trader") throw new Error("missing new-trader row");
    const [profile] = await db
      .select({ bio: users.bio })
      .from(users)
      .where(inArray(users.walletAddress, [newcomer.wallet]));
    expect(newcomer.bio).toBe(profile!.bio);
    expect(newcomer.bio).toBeString();
  });
});
