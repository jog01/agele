import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "./app";
import { env } from "./config/env";
import { createContainer } from "./container";
import { closeDb } from "./db/client";
import { logger } from "./lib/logger";
import { closeRedis } from "./lib/redis";
import { initTelemetry, shutdownTelemetry } from "./lib/telemetry";
import { WsHub } from "./ws/hub";
import { startMockFeed } from "./ws/mock-feed";
import { startPriceFeed } from "./ws/price-feed";

initTelemetry();

const container = createContainer();
const app = createApp(container);
const hub = new WsHub();

app.get(
  "/ws",
  upgradeWebSocket(() => {
    const topics = new Set<string>();
    return {
      onMessage(event, ws) {
        const raw = ws.raw;
        if (!raw) return;
        const reply = hub.handle(String(event.data), raw);
        if (reply.type === "subscribed") topics.add(reply.topic);
        if (reply.type === "unsubscribed") topics.delete(reply.topic);
        ws.send(JSON.stringify(reply));
      },
      onClose() {
        hub.release(topics);
      },
    };
  }),
);

const server = Bun.serve({ port: env.PORT, fetch: app.fetch, websocket });
hub.attach(server);
const stopFeed = env.ENABLE_MOCK_FEED && env.MARKET_DATA_PROVIDER === "mock" ? startMockFeed(hub) : undefined;
const stopPriceFeed =
  container.market.name === "live"
    ? startPriceFeed(hub, container.market, env.MARKET_TOKEN_ALLOWLIST)
    : undefined;

logger.info({ port: server.port, provider: container.market.name }, "api listening");

async function shutdown() {
  stopFeed?.();
  stopPriceFeed?.();
  await server.stop();
  await Promise.all([closeDb(), closeRedis(), shutdownTelemetry()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
