import Redis from "ioredis";
import { env } from "../config/env";

export interface EventPublisher {
  publish(topic: string, data: unknown): void | Promise<void>;
}

export interface TopicSource {
  activeTopics(): string[] | Promise<string[]>;
}

const CHANNEL = "agele:events";

export class RedisEventPublisher implements EventPublisher {
  private readonly redis = new Redis(env.REDIS_URL, { lazyConnect: true });

  async publish(topic: string, data: unknown) {
    await this.redis.publish(CHANNEL, JSON.stringify({ topic, data }));
  }

  async close() {
    await this.redis.quit();
  }
}

export async function subscribeEvents(publisher: EventPublisher) {
  const redis = new Redis(env.REDIS_URL);
  redis.on("message", (_channel, raw) => {
    try {
      const event = JSON.parse(raw);
      if (typeof event.topic === "string") void publisher.publish(event.topic, event.data);
    } catch {}
  });
  await redis.subscribe(CHANNEL);
  return () => redis.quit();
}
