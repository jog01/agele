import { MockMarketDataProvider } from "../services/market-data/mock.provider";
import type { WsHub } from "./hub";

/** Publishes synthetic trades and prices to subscribed token topics (dev/demo only). */
export function startMockFeed(hub: WsHub, market = new MockMarketDataProvider()) {
  let tick = 0;
  const timer = setInterval(async () => {
    tick++;
    const now = Math.floor(Date.now() / 1000);
    for (const topic of hub.activeTopics()) {
      const [, mint, stream] = topic.split(":");
      if (!mint || !MockMarketDataProvider.mints.includes(mint)) continue;
      if (stream === "price") {
        const token = await market.getToken(mint);
        if (token)
          hub.publish(topic, { mint, priceUsd: token.priceUsd, marketCapUsd: token.marketCapUsd, time: now });
        continue;
      }
      if (stream !== "trades") continue;
      if (Math.random() < 0.35) continue;
      hub.publish(topic, market.tradeAt(mint, now, tick));
    }
  }, 1000);
  return () => clearInterval(timer);
}
