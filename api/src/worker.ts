import { Worker } from "bullmq";
import { portfolioSnapshotProcessor } from "./jobs/processors/portfolio-snapshot";
import { getQueue, QUEUE } from "./jobs/queues";
import { logger } from "./lib/logger";
import { closeRedis, getRedis } from "./lib/redis";
import { initTelemetry, shutdownTelemetry } from "./lib/telemetry";

initTelemetry("fomo-worker");

const workers = [new Worker(QUEUE.portfolioSnapshot, portfolioSnapshotProcessor, { connection: getRedis() })];

await getQueue(QUEUE.portfolioSnapshot).upsertJobScheduler("daily-portfolio-snapshot", {
  pattern: "5 0 * * *",
  tz: "UTC",
});

for (const w of workers) {
  w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, "job failed"));
}
logger.info({ queues: workers.map((w) => w.name) }, "worker started");

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await closeRedis();
  await shutdownTelemetry();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
