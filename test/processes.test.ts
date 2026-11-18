import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { env } from "../src/config/env";
import { ActiveTopicRegistry } from "../src/events/active-topics";
import { RedisEventPublisher, subscribeEvents } from "../src/events/bus";
import { FeedLock } from "../src/events/feed-lock";
import { createTradeIndexProcessor } from "../src/jobs/processors/trade-index";
import { getQueue, QUEUE } from "../src/jobs/queues";
import { enqueueTrades } from "../src/jobs/trade-queue";
import { WsHub } from "../src/ws/hub";
import { buy } from "./fixtures/helius";

describe("process boundaries", () => {
  it("delivers Redis events to a gateway hub", async () => {
    const hub = new WsHub();
    const publisher = new RedisEventPublisher();
    let resolve!: (value: string) => void;
    const received = new Promise<string>((r) => {
      resolve = r;
    });
    hub.attach({
      publish: (_topic: string, payload: string) => {
        resolve(payload);
      },
    } as unknown as Parameters<WsHub["attach"]>[0]);
    const stop = await subscribeEvents(hub);
    try {
      await publisher.publish("leaderboard:global", { window: "24h" });
      expect(
        JSON.parse(
          await Promise.race([
            received,
            Bun.sleep(2000).then(() => {
              throw new Error("event timeout");
            }),
          ]),
        ),
      ).toEqual({ type: "event", topic: "leaderboard:global", data: { window: "24h" } });
    } finally {
      await stop();
      await publisher.close();
    }
  });

  it("expires dead replicas without dropping live replica topics", async () => {
    const redis = new Redis(env.REDIS_URL);
    const key = `test:topics:${crypto.randomUUID()}`;
    let now = 1000;
    const a = new ActiveTopicRegistry(redis, "a", 100, () => now, key);
    const b = new ActiveTopicRegistry(redis, "b", 100, () => now, key);
    try {
      expect(await a.activeTopics()).toEqual([]);
      await a.heartbeat(["token:a:price"]);
      now += 50;
      await b.heartbeat(["token:a:price", "token:b:price"]);
      now += 51;
      expect(await a.activeTopics()).toEqual(["token:a:price", "token:b:price"]);
      now += 50;
      expect(await a.activeTopics()).toEqual([]);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });

  it("allows only the lock owner to renew or release and permits takeover after expiry", async () => {
    const redis = new Redis(env.REDIS_URL);
    const key = `test:lock:${crypto.randomUUID()}`;
    const a = new FeedLock(redis, key, 100);
    const b = new FeedLock(redis, key, 100);
    try {
      expect(await a.acquire()).toBe(true);
      expect(await b.acquire()).toBe(false);
      expect(await b.renew()).toBe(false);
      await b.release();
      expect(await a.renew()).toBe(true);
      await redis.pexpire(key, 1);
      await Bun.sleep(10);
      expect(await b.acquire()).toBe(true);
      expect(await a.renew()).toBe(false);
      await a.release();
      expect(await b.renew()).toBe(true);
    } finally {
      await redis.del(key);
      await redis.quit();
    }
  });

  it("enqueues by signature with retries and deduplication", async () => {
    const tx = { ...buy, signature: `test-${crypto.randomUUID()}` };
    const queue = getQueue(QUEUE.tradeIndex);
    try {
      expect(await enqueueTrades([])).toEqual({ queued: 0 });
      expect(await enqueueTrades([tx, tx])).toEqual({ queued: 2 });
      const job = await queue.getJob(tx.signature);
      expect(job?.data).toEqual(tx);
      expect(job?.opts.attempts).toBe(5);
      expect(job?.opts.backoff).toEqual({ type: "exponential", delay: 1000 });
    } finally {
      await (await queue.getJob(tx.signature))?.remove();
    }
  });

  it("indexes one transaction and propagates failures for BullMQ retry", async () => {
    const calls: unknown[] = [];
    const processor = createTradeIndexProcessor({
      index: async (txs) => {
        calls.push(txs);
        return { indexed: 1, skipped: 0 };
      },
    });
    expect(await processor({ data: buy })).toEqual({ indexed: 1, skipped: 0 });
    expect(calls).toEqual([[buy]]);
    const failure = createTradeIndexProcessor({
      index: async () => {
        throw new Error("database unavailable");
      },
    });
    await expect(failure({ data: buy })).rejects.toThrow("database unavailable");
  });
});
