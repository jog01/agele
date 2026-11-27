import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { portfolioSnapshots, positions, tokens, trades, wallets } from "../models";

export interface TradeCursor {
  executedAt: Date;
  id: string;
}

export class PgPortfolioRepository {
  constructor(private readonly db: Db) {}

  getPositions(userId: string) {
    return this.db
      .select({ position: positions, symbol: tokens.symbol, imageUrl: tokens.imageUrl })
      .from(positions)
      .innerJoin(tokens, eq(tokens.mint, positions.mint))
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

  async upsertSnapshot(userId: string, day: string, valueUsd: string) {
    await this.db
      .insert(portfolioSnapshots)
      .values({ userId, day, valueUsd })
      .onConflictDoUpdate({ target: [portfolioSnapshots.userId, portfolioSnapshots.day], set: { valueUsd } });
  }
}
