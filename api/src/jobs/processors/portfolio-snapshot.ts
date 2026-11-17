import type { Job } from "bullmq";
import { logger } from "../../lib/logger";

/**
 * Daily sweep: value every user's holdings and write a portfolio_snapshots row.
 * TODO(feature): load wallets, price holdings via MarketDataProvider, upsert snapshots.
 */
export async function portfolioSnapshotProcessor(job: Job) {
  logger.info({ jobId: job.id }, "portfolio snapshot sweep (not implemented yet)");
  return { users: 0 };
}
