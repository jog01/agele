import type { Job } from "bullmq";
import { getDb } from "../../db/client";
import { logger } from "../../lib/logger";
import { PgPortfolioRepository } from "../../repositories/portfolio.repository";
import {
  createDemoPortfolioMarketDataProvider,
  createUpstreamMarketDataProvider,
} from "../../services/market-data";
import { createPositionQuote } from "../../services/market-data/position-quotes";
import { PortfolioService } from "../../services/portfolio.service";
import { RpcWalletBalanceProvider } from "../../services/wallet-balance.provider";

export function createPortfolioSnapshotProcessor(
  repository: PgPortfolioRepository,
  portfolio: PortfolioService,
  now: () => number = Date.now,
) {
  return async (_job: Job) => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const users = await repository.usersForSnapshots();
    let failed = 0;
    for (const { userId } of users) {
      let snapshot: Awaited<ReturnType<PortfolioService["getPortfolio"]>>;
      try {
        snapshot = await portfolio.getPortfolio(userId);
      } catch (err) {
        failed++;
        logger.warn({ err, userId }, "Could not value portfolio for daily snapshot");
        continue;
      }
      const { equityUsd, positions } = snapshot;
      const positionsValueUsd = positions.reduce((sum, position) => sum + position.valueUsd, 0);
      await repository.upsertSnapshot(userId, day, equityUsd.toFixed(18), positionsValueUsd.toFixed(18));
    }
    logger.info({ users: users.length, failed, day }, "portfolio snapshot sweep complete");
    return { users: users.length, failed };
  };
}

export async function portfolioSnapshotProcessor(job: Job) {
  const repository = new PgPortfolioRepository(getDb());
  const live = createUpstreamMarketDataProvider();
  const portfolio = new PortfolioService(
    repository,
    live,
    new RpcWalletBalanceProvider(),
    Date.now,
    createPositionQuote(live, createDemoPortfolioMarketDataProvider()),
  );
  return createPortfolioSnapshotProcessor(repository, portfolio)(job);
}
