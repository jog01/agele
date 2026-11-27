import { and, desc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  portfolioSnapshots,
  positions,
  publicPortfolioHourly,
  tokens,
  trades,
  users,
  wallets,
} from "../models";

export interface TradeCursor {
  executedAt: Date;
  id: string;
}

export class PgPortfolioRepository {
  constructor(private readonly db: Db) {}

  getPositions(userId: string) {
    return this.db
      .select({
        position: positions,
        symbol: tokens.symbol,
        imageUrl: tokens.imageUrl,
        seeded: users.demo,
      })
      .from(positions)
      .innerJoin(tokens, eq(tokens.mint, positions.mint))
      .innerJoin(users, eq(users.id, positions.userId))
      .where(eq(positions.userId, userId))
      .orderBy(positions.mint);
  }

  getWallets(userId: string) {
    return this.db
      .select({ address: wallets.address })
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.chainType, "solana")));
  }

  history(userId: string, start?: string) {
    return this.db
      .select()
      .from(portfolioSnapshots)
      .where(
        and(eq(portfolioSnapshots.userId, userId), start ? gte(portfolioSnapshots.day, start) : undefined),
      )
      .orderBy(portfolioSnapshots.day);
  }

  positionsHistory(userId: string, start?: string) {
    return this.db
      .select({ day: portfolioSnapshots.day, valueUsd: sql<string>`${portfolioSnapshots.positionsValueUsd}` })
      .from(portfolioSnapshots)
      .where(
        and(
          eq(portfolioSnapshots.userId, userId),
          isNotNull(portfolioSnapshots.positionsValueUsd),
          start ? gte(portfolioSnapshots.day, start) : undefined,
        ),
      )
      .orderBy(portfolioSnapshots.day);
  }

  hourlyPositionsHistory(userId: string, start: Date) {
    return this.db
      .select()
      .from(publicPortfolioHourly)
      .where(and(eq(publicPortfolioHourly.userId, userId), gte(publicPortfolioHourly.hour, start)))
      .orderBy(publicPortfolioHourly.hour);
  }

  async upsertHourlyPositions(userId: string, hour: Date, valueUsd: string) {
    await this.db
      .insert(publicPortfolioHourly)
      .values({ userId, hour, valueUsd })
      .onConflictDoUpdate({
        target: [publicPortfolioHourly.userId, publicPortfolioHourly.hour],
        set: { valueUsd },
      });
  }

  async pruneHourlyPositions(before: Date) {
    await this.db.delete(publicPortfolioHourly).where(lt(publicPortfolioHourly.hour, before));
  }

  getTrades(userId: string, limit: number, cursor?: TradeCursor) {
    return this.db
      .select({ trade: trades, symbol: tokens.symbol, imageUrl: tokens.imageUrl })
      .from(trades)
      .innerJoin(tokens, eq(tokens.mint, trades.mint))
      .where(
        and(
          eq(trades.userId, userId),
          cursor
            ? or(
                lt(trades.executedAt, cursor.executedAt),
                and(eq(trades.executedAt, cursor.executedAt), lt(trades.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(trades.executedAt), desc(trades.id))
      .limit(limit);
  }

  usersForSnapshots() {
    return this.db
      .select({ userId: positions.userId })
      .from(positions)
      .union(this.db.select({ userId: wallets.userId }).from(wallets).where(eq(wallets.chainType, "solana")));
  }

  async upsertSnapshot(userId: string, day: string, valueUsd: string, positionsValueUsd?: string) {
    await this.db
      .insert(portfolioSnapshots)
      .values({ userId, day, valueUsd, positionsValueUsd })
      .onConflictDoUpdate({
        target: [portfolioSnapshots.userId, portfolioSnapshots.day],
        set: { valueUsd, positionsValueUsd },
      });
  }
}
