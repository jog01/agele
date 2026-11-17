import type Redis from "ioredis";
import { AppError } from "../../lib/errors";

export interface SwapRateLimiter {
  consume(key: string): Promise<void>;
}

export class RedisSwapRateLimiter implements SwapRateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(key: string) {
    let count: unknown;
    try {
      count = await this.redis.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        1,
        `swap-quote:${key}`,
      );
    } catch {
      throw new AppError(503, "rate_limit_unavailable", "Swap quoting temporarily unavailable");
    }
    if (Number(count) > 30) throw new AppError(429, "rate_limited", "Swap quote limit exceeded");
  }
}
