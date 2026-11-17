import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { positions, tokens, trades, users } from "../models";

export interface TokenTraderCursor {
  mint: string;
  volumeUsd: string;
  userId: string;
}

export class PgTokenActivityRepository {
  constructor(private readonly db: Db) {}

  async getToken(mint: string) {
    const [token] = await this.db.select().from(tokens).where(eq(tokens.mint, mint));
    return token;
  }

  async getPosition(userId: string, mint: string) {
    const [position] = await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.mint, mint)));
    return position;
  }

  getTraders(mint: string, limit: number, cursor?: TokenTraderCursor) {
    const totals = this.db
      .select({
        userId: trades.userId,
        volumeUsd: sql<string>`sum(${trades.quoteAmountUsd})`.as("volume_usd"),
        buys: sql<number>`count(*) filter (where ${trades.side} = 'buy')`.mapWith(Number).as("buys"),
        sells: sql<number>`count(*) filter (where ${trades.side} = 'sell')`.mapWith(Number).as("sells"),
        realizedPnlUsd: sql<string>`coalesce(sum(${trades.realizedPnlUsd}), 0)`.as("trade_realized_pnl_usd"),
      })
      .from(trades)
      .where(eq(trades.mint, mint))
      .groupBy(trades.userId)
      .as("totals");

    return this.db
      .select({
        userId: totals.userId,
        wallet: users.walletAddress,
        handle: users.handle,
        volumeUsd: totals.volumeUsd,
        buys: totals.buys,
        sells: totals.sells,
        realizedPnlUsd: totals.realizedPnlUsd,
        position: positions,
      })
      .from(totals)
      .innerJoin(users, eq(users.id, totals.userId))
      .leftJoin(positions, and(eq(positions.userId, totals.userId), eq(positions.mint, mint)))
      .where(
        cursor
          ? or(
              lt(totals.volumeUsd, sql`${cursor.volumeUsd}::numeric`),
              and(eq(totals.volumeUsd, sql`${cursor.volumeUsd}::numeric`), gt(totals.userId, cursor.userId)),
            )
          : undefined,
      )
      .orderBy(desc(totals.volumeUsd), asc(totals.userId))
      .limit(limit);
  }
}
