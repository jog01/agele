import type Redis from "ioredis";
import type { TopicSource } from "./bus";

export class ActiveTopicRegistry implements TopicSource {
  constructor(
    private readonly redis: Redis,
    private readonly replica: string = crypto.randomUUID(),
    private readonly ttl = 15000,
    private readonly now = Date.now,
    private readonly key = "agele:active-topics",
  ) {}

  async heartbeat(topics: string[]) {
    const tx = this.redis.multi();
    for (const topic of topics) tx.zadd(this.key, this.now() + this.ttl, `${this.replica}|${topic}`);
    await tx.exec();
  }

  async activeTopics() {
    await this.redis.zremrangebyscore(this.key, "-inf", this.now());
    const entries = await this.redis.zrangebyscore(this.key, this.now() + 1, "+inf");
    return [...new Set(entries.map((entry) => entry.slice(entry.indexOf("|") + 1)))];
  }
}
