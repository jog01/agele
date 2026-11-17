import { expect, it, mock } from "bun:test";
import type Redis from "ioredis";
import { RedisSwapRateLimiter } from "../src/services/trading/swap-rate-limiter";

it("allows 30 quote issues, rejects the 31st and uses an atomic expiring Redis counter", async () => {
  let count = 0;
  const evaluate = mock(async (_script: string, _count: number, _key: string) => ++count);
  const limiter = new RedisSwapRateLimiter({ eval: evaluate } as unknown as Redis);
  for (let n = 0; n < 30; n++) await limiter.consume("user:test");
  await expect(limiter.consume("user:test")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  expect(evaluate.mock.calls[0]).toEqual([
    "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
    1,
    "swap-quote:user:test",
  ]);
});

it("fails closed when rate-limit storage fails", async () => {
  const limiter = new RedisSwapRateLimiter({
    eval: async () => {
      throw new Error("unavailable");
    },
  } as unknown as Redis);
  await expect(limiter.consume("ip:test")).rejects.toMatchObject({
    status: 503,
    code: "rate_limit_unavailable",
  });
});

it("returns 503 by the deadline when rate-limit storage hangs", async () => {
  const limiter = new RedisSwapRateLimiter(
    {
      eval: () => new Promise(() => {}),
    } as unknown as Redis,
    10,
  );
  await expect(limiter.consume("ip:test")).rejects.toMatchObject({
    status: 503,
    code: "rate_limit_unavailable",
  });
});
