import { env } from "../config/env";
import { ActiveTopicRegistry } from "../events/active-topics";
import { RedisEventPublisher } from "../events/bus";
import { FeedLock } from "../events/feed-lock";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { createMarketDataProvider } from "../services/market-data";
import { startMockFeed } from "../ws/mock-feed";
import { startPriceFeed } from "../ws/price-feed";

const redis = getRedis();
const lock = new FeedLock(redis);
const registry = new ActiveTopicRegistry(redis);
const events = new RedisEventPublisher();
const market = createMarketDataProvider();
let owner = false;
let stop: (() => void) | undefined;
const source = {
  activeTopics: async () => (owner && (await lock.renew()) ? registry.activeTopics() : []),
  publish: async (topic: string, data: unknown) => {
    if (owner && (await lock.renew())) await events.publish(topic, data);
  },
};
async function elect() {
  try {
    if (owner && !(await lock.renew())) {
      owner = false;
      stop?.();
      stop = undefined;
    }
    if (!owner && (await lock.acquire())) {
      owner = true;
      stop =
        market.name === "live"
          ? startPriceFeed(source, market, env.MARKET_TOKEN_ALLOWLIST)
          : env.ENABLE_MOCK_FEED
            ? startMockFeed(source)
            : undefined;
      logger.info("feed lock acquired");
    }
  } catch (err) {
    owner = false;
    stop?.();
    stop = undefined;
    logger.warn({ err }, "feed lock unavailable");
  }
}
await elect();
const timer = setInterval(() => {
  void elect();
}, 3000);
logger.info("feed started (standby unless lock owner)");
async function shutdown() {
  clearInterval(timer);
  owner = false;
  stop?.();
  await lock.release();
  await events.close();
  await closeRedis();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
