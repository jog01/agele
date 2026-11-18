import { createApp } from "../app";
import { env } from "../config/env";
import { createContainer } from "../container";
import { closeDb } from "../db/client";
import { RedisEventPublisher } from "../events/bus";
import { closeQueues } from "../jobs/queues";
import { logger } from "../lib/logger";
import { closeRedis } from "../lib/redis";
import { initTelemetry, shutdownTelemetry } from "../lib/telemetry";

initTelemetry();
const container = createContainer();
await container.feeSponsor.ready?.();
const app = createApp(container);
const server = Bun.serve({ port: env.PORT, fetch: app.fetch });
logger.info({ port: server.port }, "api listening");
async function shutdown() {
  await server.stop();
  await closeQueues();
  if (container.events instanceof RedisEventPublisher) await container.events.close();
  await Promise.all([closeDb(), closeRedis(), shutdownTelemetry()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
