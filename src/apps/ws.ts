import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { env } from "../config/env";
import { ActiveTopicRegistry } from "../events/active-topics";
import { subscribeEvents } from "../events/bus";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { WsHub } from "../ws/hub";

const app = new Hono();
const hub = new WsHub();
const registry = new ActiveTopicRegistry(getRedis());
app.get("/health", (c) => c.json({ ok: true }));
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

const server = Bun.serve({ port: env.WS_PORT, fetch: app.fetch, websocket });
hub.attach(server);
const unsubscribe = await subscribeEvents(hub);
const timer = setInterval(() => {
  void registry.heartbeat(hub.activeTopics()).catch((err) => logger.warn({ err }, "Topic heartbeat failed"));
}, 3000);
logger.info({ port: server.port }, "ws listening");
async function shutdown() {
  clearInterval(timer);
  await server.stop(true);
  await unsubscribe();
  await closeRedis();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
