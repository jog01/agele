import type { Job } from "bullmq";
import { getDb } from "../../db/client";
import { logger } from "../../lib/logger";
import { PgPortfolioRepository } from "../../repositories/portfolio.repository";
import { createMarketDataProvider } from "../../services/market-data";
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
    for (const { userId } of users) {
      const { equityUsd } = await portfolio.getPortfolio(userId);
      await repository.upsertSnapshot(userId, day, equityUsd.toFixed(18));
    }
    logger.info({ users: users.length, day }, "portfolio snapshot sweep complete");
    return { users: users.length };
  };
}

export async function portfolioSnapshotProcessor(job: Job) {
  const repository = new PgPortfolioRepository(getDb());
  const portfolio = new PortfolioService(
    repository,
    createMarketDataProvider(),
    new RpcWalletBalanceProvider(),
  );
  return createPortfolioSnapshotProcessor(repository, portfolio)(job);
}
