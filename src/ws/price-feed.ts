import type { EventPublisher, TopicSource } from "../events/bus";
import { logger } from "../lib/logger";
import type { PriceTick } from "../schemas/token";
import type { MarketDataProvider } from "../services/market-data/provider";
import { PRICE_TOPIC_RE } from "./topics";

const TOPICS_PER_TICK = 20;

export function createPricePoller(
  hub: EventPublisher & TopicSource,
  market: Pick<MarketDataProvider, "getToken">,
  now: () => number = Date.now,
) {
  let running = false;
  let cursor = 0;
  return async () => {
    if (running) return;
    running = true;
    try {
      const topics = [
        ...new Set((await hub.activeTopics()).filter((topic) => PRICE_TOPIC_RE.test(topic))),
      ].sort();
      if (!topics.length) return;
      const count = Math.min(topics.length, TOPICS_PER_TICK);
      const results = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          const topic = topics[(cursor + index) % topics.length]!;
          const mint = PRICE_TOPIC_RE.exec(topic)![1]!;
          return { topic, token: await market.getToken(mint) };
        }),
      );
      cursor = (cursor + count) % topics.length;
      const active = new Set(await hub.activeTopics());
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn("Price lookup failed; skipping token");
          continue;
        }
        const { topic, token } = result.value;
        if (!token || !active.has(topic)) continue;
        const data: PriceTick = {
          mint: token.mint,
          priceUsd: token.priceUsd,
          marketCapUsd: token.marketCapUsd,
          time: Math.floor(now() / 1000),
        };
        await hub.publish(topic, data);
      }
    } catch {
      logger.warn("Price poll failed; skipping tick");
    } finally {
      running = false;
    }
  };
}

export function startPriceFeed(
  hub: EventPublisher & TopicSource,
  market: Pick<MarketDataProvider, "getToken">,
) {
  const tick = createPricePoller(hub, market);
  const timer = setInterval(() => {
    void tick();
  }, 5000);
  return () => clearInterval(timer);
}
