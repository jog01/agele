import { logger } from "../lib/logger";
import type { PriceTick } from "../schemas/token";
import type { MarketDataProvider } from "../services/market-data/provider";
import type { WsHub } from "./hub";

export function createPricePoller(
  hub: Pick<WsHub, "activeTopics" | "publish">,
  market: MarketDataProvider,
  allowlist: readonly string[],
  now: () => number = Date.now,
) {
  let running = false;
  return async () => {
    if (running) return;
    const topics = hub.activeTopics().filter((topic) => {
      const [entity, mint, stream] = topic.split(":");
      return entity === "token" && stream === "price" && !!mint && allowlist.includes(mint);
    });
    if (!topics.length) return;
    running = true;
    try {
      await Promise.all(
        topics.map(async (topic) => {
          const mint = topic.split(":")[1]!;
          const token = await market.getToken(mint);
          if (!token || !hub.activeTopics().includes(topic)) return;
          const data: PriceTick = {
            mint,
            priceUsd: token.priceUsd,
            marketCapUsd: token.marketCapUsd,
            time: Math.floor(now() / 1000),
          };
          hub.publish(topic, data);
        }),
      );
    } catch {
      logger.warn("Price poll failed; skipping tick");
    } finally {
      running = false;
    }
  };
}

export function startPriceFeed(hub: WsHub, market: MarketDataProvider, allowlist: readonly string[]) {
  const tick = createPricePoller(hub, market, allowlist);
  const timer = setInterval(() => {
    void tick();
  }, 5000);
  return () => clearInterval(timer);
}
