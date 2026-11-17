import { MockMarketDataProvider } from "../services/market-data/mock.provider";
import type { WsHub } from "./hub";

/** Publishes synthetic trades to subscribed `token:<mint>:trades` topics (dev/demo only). */
export function startMockFeed(hub: WsHub, market = new MockMarketDataProvider()) {
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const now = Math.floor(Date.now() / 1000);
    for (const topic of hub.activeTopics()) {
      const [, mint, stream] = topic.split(":");
      if (!mint || stream !== "trades" || !MockMarketDataProvider.mints.includes(mint)) continue;
      if (Math.random() < 0.35) continue;
      hub.publish(topic, market.tradeAt(mint, now, tick));
    }
  }, 1000);
  return () => clearInterval(timer);
}
