import type Redis from "ioredis";

export class FeedLock {
  private readonly token = crypto.randomUUID();
  constructor(
    private readonly redis: Redis,
    private readonly key = "agele:feed-lock",
    private readonly ttl = 15000,
  ) {}

  async acquire() {
    return (await this.redis.set(this.key, this.token, "PX", this.ttl, "NX")) === "OK";
  }

  async renew() {
    return (
      (await this.redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end",
        1,
        this.key,
        this.token,
        this.ttl,
      )) === 1
    );
  }

  async release() {
    await this.redis.eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      this.key,
      this.token,
    );
  }
}
