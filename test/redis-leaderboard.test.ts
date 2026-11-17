import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { env } from "../src/config/env";
import { LEADERBOARD_WINDOWS, RedisLeaderboard } from "../src/services/social/leaderboard-store";

describe("Redis leaderboard integration", () => {
  it("stores scores/stats atomically, replaces snapshots and removes aged members", async () => {
    const redis = new Redis(env.REDIS_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
    const store = new RedisLeaderboard(redis);
    const row = { userId: "user", pnlUsd: 12, volumeUsd: 100, trades: 2, winRatePct: 100, pnlPct: 12 };
    try {
      await store.replace({ "24h": [row], "7d": [row], "30d": [row] });
      expect(await store.top("24h", 10)).toEqual([row]);
      expect(await redis.zscore("leaderboard:24h", "user")).toBe("12");
      expect(JSON.parse((await redis.hget("leaderboard:24h:stats", "user"))!)).toEqual({
        volumeUsd: 100,
        trades: 2,
        winRatePct: 100,
        pnlPct: 12,
      });
      await store.update("24h", "second", { ...row, userId: "second", pnlUsd: 20 });
      expect((await store.top("24h", 1))[0]!.userId).toBe("second");
      await store.update("24h", "second", null);
      expect(await store.top("24h", 10)).toEqual([row]);
      await store.replace({ "24h": [], "7d": [], "30d": [] });
      expect(await store.top("24h", 10)).toEqual([]);
      expect(await redis.hlen("leaderboard:7d:stats")).toBe(0);
    } finally {
      await redis.del(
        ...LEADERBOARD_WINDOWS.flatMap((window) => [`leaderboard:${window}`, `leaderboard:${window}:stats`]),
      );
      await redis.quit();
    }
  });
});
