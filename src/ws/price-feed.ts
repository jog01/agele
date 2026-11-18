import type { EventPublisher, TopicSource } from "../events/bus";
import { logger } from "../lib/logger";
import type { PriceTick } from "../schemas/token";
import type { MarketDataProvider } from "../services/market-data/provider";

export function createPricePoller(
  hub: EventPublisher & TopicSource,
  market: MarketDataProvider,
  allowlist: readonly string[],
  now: () => number = Date.now,
) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const topics = (await hub.activeTopics()).filter((topic) => {
        const [entity, mint, stream] = topic.split(":");
        return entity === "token" && stream === "price" && !!mint && allowlist.includes(mint);
      });
      if (!topics.length) return;
      await Promise.all(
        topics.map(async (topic) => {
          const mint = topic.split(":")[1]!;
          const token = await market.getToken(mint);
          if (!token || !(await hub.activeTopics()).includes(topic)) return;
          const data: PriceTick = {
            mint,
            priceUsd: token.priceUsd,
            marketCapUsd: token.marketCapUsd,
            time: Math.floor(now() / 1000),
          };
          await hub.publish(topic, data);
        }),
      );
    } catch {
      logger.warn("Price poll failed; skipping tick");
    } finally {
      running = false;
    }
  };
}

export function startPriceFeed(
  hub: EventPublisher & TopicSource,
  market: MarketDataProvider,
  allowlist: readonly string[],
) {
  const tick = createPricePoller(hub, market, allowlist);
  const timer = setInterval(() => {
    void tick();
  }, 5000);
  return () => clearInterval(timer);
}
