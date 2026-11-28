import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { env } from "../config/env";
import { closeDb, getDb } from "../db/client";
import { ActiveTopicRegistry } from "../events/active-topics";
import { subscribeEvents } from "../events/bus";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { PgNotificationRepository } from "../repositories/notification.repository";
import { PgUserRepository } from "../repositories/user.repository";
import { createAuthVerifier } from "../services/auth.service";
import { WsHub } from "../ws/hub";
import { NotificationSocketSession } from "../ws/notification-session";
import { isPrivateTopic } from "../ws/topics";

const app = new Hono();
const hub = new WsHub();
const registry = new ActiveTopicRegistry(getRedis());
const verifier = createAuthVerifier();
const users = new PgUserRepository(getDb());
const notifications = new PgNotificationRepository(getDb());
app.get("/health", (c) => c.json({ ok: true }));
app.get(
  "/ws",
  upgradeWebSocket(() => {
    const topics = new Set<string>();
    const auth = new NotificationSocketSession(
      async (token) => {
        const session = await verifier.verifySession(token);
        const user = await users.findByPrivyDid(session.privyDid);
        if (user && !user.demo) {
          const wallet = await notifications.walletFor(user.id);
          if (wallet) return { wallet, expiresAt: session.expiresAt };
        }
      },
      () => close?.(),
    );
    let close: (() => void) | undefined;
    let closed = false;
    return {
      onOpen(_event, ws) {
        close = () => ws.close(1008, "Authentication expired");
      },
      async onMessage(event, ws) {
        const raw = ws.raw;
        if (!raw) return;
        const frame = String(event.data);
        const authReply = await auth.handle(frame);
        if (closed) return;
        const reply = authReply ?? hub.handle(frame, raw, auth.authorizedTopic());
        if (reply.type === "subscribed") topics.add(reply.topic);
        if (reply.type === "unsubscribed") topics.delete(reply.topic);
        ws.send(JSON.stringify(reply));
      },
      onClose() {
        closed = true;
        auth.close();
        hub.release(topics);
      },
    };
  }),
);

const server = Bun.serve({ port: env.WS_PORT, fetch: app.fetch, websocket });
hub.attach(server);
const unsubscribe = await subscribeEvents(hub);
const timer = setInterval(() => {
  void registry
    .heartbeat(hub.activeTopics().filter((topic) => !isPrivateTopic(topic)))
    .catch((err) => logger.warn({ err }, "Topic heartbeat failed"));
}, 3000);
logger.info({ port: server.port }, "ws listening");
async function shutdown() {
  clearInterval(timer);
  await server.stop(true);
  await unsubscribe();
  await Promise.all([closeDb(), closeRedis()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
