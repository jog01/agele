import { Worker } from "bullmq";
import { env } from "../config/env";
import { closeDb, getDb } from "../db/client";
import { guardLiveStartup } from "../db/live-data-guard";
import { RedisEventPublisher } from "../events/bus";
import { portfolioSnapshotProcessor } from "../jobs/processors/portfolio-snapshot";
import { createTradeIndexProcessor } from "../jobs/processors/trade-index";
import { closeQueues, getQueue, QUEUE } from "../jobs/queues";
import { logger } from "../lib/logger";
import { closeRedis, getRedis } from "../lib/redis";
import { initTelemetry, shutdownTelemetry } from "../lib/telemetry";
import { PgLeaderboardRepository } from "../repositories/leaderboard.repository";
import { PgNotificationRepository } from "../repositories/notification.repository";
import { PgTradeRepository } from "../repositories/trade.repository";
import { LeaderboardService } from "../services/leaderboard.service";
import {
  createDemoPortfolioMarketDataProvider,
  createUpstreamMarketDataProvider,
} from "../services/market-data";
import { createPositionQuote } from "../services/market-data/position-quotes";
import { NotificationService } from "../services/notification.service";
import { RedisLeaderboard } from "../services/social/leaderboard-store";
import { TradeIndexer } from "../services/trade-indexer";

await guardLiveStartup();
initTelemetry("fomo-worker");
const events = new RedisEventPublisher();
const notifications = new NotificationService(new PgNotificationRepository(getDb()), events);
const market = createUpstreamMarketDataProvider();
const leaderboard = env.HELIUS_WEBHOOK_SECRET
  ? new LeaderboardService(
      new PgLeaderboardRepository(getDb()),
      new RedisLeaderboard(),
      market,
      events,
      Date.now,
      createPositionQuote(market, createDemoPortfolioMarketDataProvider()),
      notifications.rankChanged,
    )
  : undefined;
const indexer = new TradeIndexer(new PgTradeRepository(getDb(), notifications.inboxChanged), market);
if (leaderboard) indexer.onTrade((trade) => leaderboard.updateUser(trade.userId, trade.id));
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
await getQueue(QUEUE.portfolioSnapshot).upsertJobScheduler(
  "hourly-public-portfolio-snapshot",
  { pattern: "10 * * * *", tz: "UTC" },
  { name: "hourly-public-portfolio-snapshot", opts: scheduledRetention },
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
