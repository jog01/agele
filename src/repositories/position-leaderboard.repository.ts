import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { comments, type Trade, theses, tokens, trades } from "../models";

export type PositionTrader = {
  id: string;
  wallet: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  demo: boolean;
};
export interface PositionThesis {
  positionId: string;
  id: string;
  body: string;
  createdAt: Date;
}
export interface PositionToken {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
}

export interface PositionLeaderboardRepository {
  /** Full fill history of every user/token pair with a fill at or after `since` (all pairs when omitted), oldest first. */
  getFills(since?: Date): Promise<Trade[]>;
  getTraders(ids: string[]): Promise<PositionTrader[]>;
  /** Latest thesis version for each position's opening fill. */
  getTheses(positionIds: string[]): Promise<PositionThesis[]>;
  getTokens(mints: string[]): Promise<PositionToken[]>;
}

export class PgPositionLeaderboardRepository implements PositionLeaderboardRepository {
  constructor(private readonly db: Db) {}

  getFills(since?: Date) {
    const active = since
      ? sql`(${trades.userId}, ${trades.mint}) in (
          select user_id, mint from trades where executed_at >= ${since.toISOString()}::timestamptz
        )`
      : undefined;
    return this.db.select().from(trades).where(active).orderBy(asc(trades.executedAt), asc(trades.id));
  }

  async getTraders(ids: string[]) {
    if (!ids.length) return [];
    return this.db.execute<PositionTrader>(sql`
      select u.id, coalesce(u.wallet_address, (
          select w.address from wallets w where w.user_id = u.id and w.chain_type = 'solana'
          order by w.is_primary desc, w.address limit 1
        )) as wallet,
        u.handle, u.display_name as "displayName", u.avatar_url as "avatarUrl", u.demo
      from users u where u.id = any(${sql.param(ids)}::uuid[])
    `);
  }

  async getTheses(positionIds: string[]) {
    if (!positionIds.length) return [];
    return this.db
      .selectDistinctOn([theses.positionId], {
        positionId: theses.positionId,
        id: theses.id,
        body: comments.body,
        createdAt: comments.createdAt,
      })
      .from(theses)
      .innerJoin(comments, and(eq(comments.thesisId, theses.id), eq(comments.kind, "thesis")))
      .where(inArray(theses.positionId, positionIds))
      .orderBy(theses.positionId, sql`${comments.createdAt} desc`, sql`${comments.id} desc`);
  }

  async getTokens(mints: string[]) {
    if (!mints.length) return [];
    return this.db
      .select({ mint: tokens.mint, symbol: tokens.symbol, name: tokens.name, imageUrl: tokens.imageUrl })
      .from(tokens)
      .where(inArray(tokens.mint, mints));
  }
}
