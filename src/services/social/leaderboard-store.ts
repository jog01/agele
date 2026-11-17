import type Redis from "ioredis";
import { getRedis } from "../../lib/redis";
import type { LeaderboardWindowValue } from "../../schemas/social";

export const LEADERBOARD_WINDOWS = ["24h", "7d", "30d"] as const;
export interface LeaderboardStats {
  volumeUsd: number;
  trades: number;
  winRatePct: number;
  pnlPct: number;
}
export interface LeaderboardRow extends LeaderboardStats {
  userId: string;
  pnlUsd: number;
}
export type LeaderboardSnapshot = Record<LeaderboardWindowValue, LeaderboardRow[]>;

export interface LeaderboardStore {
  replace(snapshot: LeaderboardSnapshot): Promise<void>;
  update(window: LeaderboardWindowValue, userId: string, row: LeaderboardRow | null): Promise<void>;
  top(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardRow[]>;
  rank(window: LeaderboardWindowValue, userId: string): Promise<number | null>;
}

const key = (window: LeaderboardWindowValue) => `leaderboard:${window}`;
const statsJson = ({ volumeUsd, trades, winRatePct, pnlPct }: LeaderboardRow) =>
  JSON.stringify({ volumeUsd, trades, winRatePct, pnlPct });

export class RedisLeaderboard implements LeaderboardStore {
  constructor(private readonly redis: Redis = getRedis()) {}

  async rank(window: LeaderboardWindowValue, userId: string) {
    const rank = await this.redis.zrevrank(key(window), userId);
    return rank === null ? null : rank + 1;
  }

  private check(result: [Error | null, unknown][] | null) {
    if (!result) throw new Error("Leaderboard transaction aborted");
    for (const [error] of result) if (error) throw error;
  }

  async replace(snapshot: LeaderboardSnapshot) {
    const transaction = this.redis.multi();
    for (const window of LEADERBOARD_WINDOWS) {
      transaction.del(key(window), `${key(window)}:stats`);
      for (const row of snapshot[window]) {
        transaction.zadd(key(window), row.pnlUsd, row.userId);
        transaction.hset(`${key(window)}:stats`, row.userId, statsJson(row));
      }
    }
    this.check(await transaction.exec());
  }

  async update(window: LeaderboardWindowValue, userId: string, row: LeaderboardRow | null) {
    const transaction = this.redis.multi();
    if (row) {
      transaction.zadd(key(window), row.pnlUsd, userId);
      transaction.hset(`${key(window)}:stats`, userId, statsJson(row));
    } else {
      transaction.zrem(key(window), userId);
      transaction.hdel(`${key(window)}:stats`, userId);
    }
    this.check(await transaction.exec());
  }

  async top(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardRow[]> {
    const result = await this.redis
      .multi()
      .zrevrange(key(window), 0, limit - 1, "WITHSCORES")
      .hgetall(`${key(window)}:stats`)
      .exec();
    this.check(result);
    const scores = result![0]![1] as string[];
    const stats = result![1]![1] as Record<string, string>;
    const rows: LeaderboardRow[] = [];
    for (let i = 0; i < scores.length; i += 2) {
      const userId = scores[i]!;
      if (stats[userId]) rows.push({ ...JSON.parse(stats[userId]!), userId, pnlUsd: Number(scores[i + 1]) });
    }
    return rows;
  }
}
