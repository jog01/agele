import { and, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { type Position, positions, type Trade, trades, users } from "../models";

export class PgLeaderboardRepository {
  constructor(private readonly db: Db) {}

  async getTrades(since: Date, userId?: string) {
    return this.db
      .select()
      .from(trades)
      .where(and(gte(trades.executedAt, since), userId ? eq(trades.userId, userId) : undefined));
  }

  async getPositions(userId?: string) {
    return this.db
      .select()
      .from(positions)
      .where(userId ? eq(positions.userId, userId) : undefined);
  }

  async getUsers(ids: string[]) {
    if (!ids.length) return [];
    return this.db
      .select({ id: users.id, wallet: users.walletAddress, handle: users.handle })
      .from(users)
      .where(inArray(users.id, ids));
  }
}

export interface LeaderboardRepository {
  getTrades(since: Date, userId?: string): Promise<Trade[]>;
  getPositions(userId?: string): Promise<Position[]>;
  getUsers(ids: string[]): Promise<{ id: string; wallet: string | null; handle: string | null }[]>;
}
