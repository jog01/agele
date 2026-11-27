import { describe, expect, it } from "bun:test";
import { PriceTickSchema } from "../src/schemas/token";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { createPricePoller } from "../src/ws/price-feed";
import prices from "./fixtures/jupiter-prices.json";
import metadata from "./fixtures/jupiter-tokens.json";

const mints = metadata.map((t) => t.id);
describe("WS live price polling", () => {
  function setup(fail = false) {
    let now = 1_800_000_000_000;
    let topics: string[] = [];
    const events: { topic: string; data: unknown }[] = [];
    const requests: string[] = [];
    const market = new LiveMarketDataProvider({
      now: () => now,
      fetch: async (url) => {
        requests.push(url);
        if (fail) throw new Error("offline");
        return Response.json(url.includes("search") ? metadata : prices);
      },
    });
    const tick = createPricePoller(
      {
        activeTopics: () => topics,
        publish: (topic, data) => {
          events.push({ topic, data });
        },
      },
      market,
      () => now,
    );
    return {
      tick,
      requests,
      events,
      subscribe: (value: string[]) => {
        topics = value;
      },
      advance: () => {
        now += 5000;
      },
    };
  }

  it("polls valid subscribed mints only and caches their metadata between ticks", async () => {
    const s = setup();
    const topics = mints.slice(0, 2).map((mint) => `token:${mint}:price`);
    s.subscribe([...topics, `token:${mints[2]}:trades`, "token:unknown:price"]);
    await Promise.all([s.tick(), s.tick()]);
    expect(s.events.map((e) => e.topic)).toEqual([...topics].sort());
    for (const event of s.events) {
      const data = PriceTickSchema.parse(event.data);
      expect(data.time).toBe(1_800_000_000);
      expect(data.priceUsd).toBe(prices[data.mint as keyof typeof prices]!.usdPrice);
      expect(data.marketCapUsd).toBe(metadata.find((t) => t.id === data.mint)!.mcap);
    }
    expect(s.requests).toHaveLength(4);
    expect(
      s.requests
        .map((url) => new URL(url).searchParams.get("ids"))
        .filter(Boolean)
        .sort(),
    ).toEqual(mints.slice(0, 2).sort());
    s.advance();
    await s.tick();
    expect(s.requests).toHaveLength(6);
    expect(s.events).toHaveLength(4);
  });

  it("does no fetching or publishing without eligible subscriptions", async () => {
    const s = setup();
    await s.tick();
    s.subscribe([`token:${mints[0]}:trades`, "token:unknown:price"]);
    await s.tick();
    expect(s.requests).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });

  it("does not publish after unsubscribe during a request", async () => {
    const s = setup();
    s.subscribe([`token:${mints[0]}:price`]);
    const pending = s.tick();
    s.subscribe([]);
    await pending;
    expect(s.events).toHaveLength(0);
  });

  it("skips failed upstream ticks and can retry next tick", async () => {
    const s = setup(true);
    s.subscribe([`token:${mints[0]}:price`]);
    await s.tick();
    await s.tick();
    expect(s.requests).toHaveLength(2);
    expect(s.events).toHaveLength(0);
  });

  it("recovers after an asynchronous topic registry failure", async () => {
    let fail = true;
    const events: unknown[] = [];
    const tick = createPricePoller(
      {
        activeTopics: async () => {
          if (fail) throw new Error("redis unavailable");
          return [];
        },
        publish: (_topic, data) => {
          events.push(data);
        },
      },
      new LiveMarketDataProvider({}),
    );
    await tick();
    fail = false;
    await tick();
    expect(events).toEqual([]);
  });

  it("caps each tick at 20 mints and rotates through large subscriptions", async () => {
    const topics = Array.from("ABCDEFGHJKLMNPQRSTUVWXYZ", (last) => `token:${"1".repeat(31)}${last}:price`);
    const lookedUp: string[] = [];
    const tick = createPricePoller(
      { activeTopics: () => topics, publish: () => {} },
      {
        getToken: async (mint) => {
          lookedUp.push(mint);
          return null;
        },
      },
    );
    await tick();
    expect(lookedUp).toHaveLength(20);
    await tick();
    expect(lookedUp).toHaveLength(40);
    expect(new Set(lookedUp).size).toBe(topics.length);
  });
});
