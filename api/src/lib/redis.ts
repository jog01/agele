import Redis from "ioredis";
import { env } from "../config/env";

let client: Redis | undefined;

/** Lazily connected so the API boots (and tests run) without Redis. */
export function getRedis(): Redis {
  client ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  return client;
}

export async function closeRedis() {
  await client?.quit();
  client = undefined;
}
