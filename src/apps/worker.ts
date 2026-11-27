import { Worker } from "bullmq";
import { env } from "../config/env";
import { closeDb, getDb } from "../db/client";
import { RedisEventPublisher } from "../events/bus";
import { portfolioSnapshotProcessor } from "../jobs/processors/portfolio-snapshot";
import { createTradeIndexProcessor } from "../jobs/processors/trade-index";
import { closeQueues, getQueue, QUEUE } from "../jobs/queues";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { initTelemetry, shutdownTelemetry } from "../lib/telemetry";
import { PgLeaderboardRepository } from "../repositories/leaderboard.repository";
import { PgTradeRepository } from "../repositories/trade.repository";
import { LeaderboardService } from "../services/leaderboard.service";
import { createMarketDataProvider } from "../services/market-data";
import { RedisLeaderboard } from "../services/social/leaderboard-store";
import { TradeIndexer } from "../services/trade-indexer";

initTelemetry("fomo-worker");
const events = new RedisEventPublisher();
const market = createMarketDataProvider();
const leaderboard = env.HELIUS_WEBHOOK_SECRET
  ? new LeaderboardService(new PgLeaderboardRepository(getDb()), new RedisLeaderboard(), market, events)
  : undefined;
const indexer = new TradeIndexer(new PgTradeRepository(getDb()), createMarketDataProvider("live"));
if (leaderboard) indexer.onTrade((trade) => leaderboard.updateUser(trade.userId));
const connection = getRedis();
const scheduledRetention = { removeOnComplete: 100, removeOnFail: 500 };
const workers = [
  new Worker(QUEUE.tradeIndex, createTradeIndexProcessor(indexer), { connection }),
  new Worker(QUEUE.portfolioSnapshot, portfolioSnapshotProcessor, { connection }),
  new Worker(
    QUEUE.leaderboardRebuild,
    async () => {
      await leaderboard?.rebuild();
    },
    { connection },
  ),
];
await getQueue(QUEUE.portfolioSnapshot).upsertJobScheduler(
  "daily-portfolio-snapshot",
  {
    pattern: "5 0 * * *",
    tz: "UTC",
  },
  { opts: scheduledRetention },
);
await getQueue(QUEUE.leaderboardRebuild).upsertJobScheduler(
  "leaderboard-rebuild",
  { every: 60000 },
  { opts: scheduledRetention },
);
for (const w of workers)
  w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err }, "job failed"));
logger.info({ queues: workers.map((w) => w.name) }, "worker started");
async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await events.close();
  await Promise.all([closeDb(), closeRedis(), shutdownTelemetry()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
