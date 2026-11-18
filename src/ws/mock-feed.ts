import type { EventPublisher, TopicSource } from "../events/bus";
import { logger } from "../lib/logger";
import { MockMarketDataProvider } from "../services/market-data/mock.provider";

/** Publishes synthetic trades and prices to subscribed token topics (dev/demo only). */
export function startMockFeed(hub: EventPublisher & TopicSource, market = new MockMarketDataProvider()) {
  let tick = 0;
  const timer = setInterval(async () => {
    try {
      tick++;
      const now = Math.floor(Date.now() / 1000);
      for (const topic of await hub.activeTopics()) {
        const [, mint, stream] = topic.split(":");
        if (!mint || !MockMarketDataProvider.mints.includes(mint)) continue;
        if (stream === "price") {
          const token = await market.getToken(mint);
          if (token)
            await hub.publish(topic, {
              mint,
              priceUsd: token.priceUsd,
              marketCapUsd: token.marketCapUsd,
              time: now,
            });
          continue;
        }
        if (stream !== "trades") continue;
        if (Math.random() < 0.35) continue;
        await hub.publish(topic, market.tradeAt(mint, now, tick));
      }
    } catch (err) {
      logger.warn({ err }, "Mock feed failed");
    }
  }, 1000);
  return () => clearInterval(timer);
}
