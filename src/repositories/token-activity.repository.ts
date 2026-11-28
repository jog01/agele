import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { positions, tokens, trades, users } from "../models";

export interface TokenTraderCursor {
  mint: string;
  volumeUsd: string;
  userId: string;
}

export type TokenHolderUserRow = {
  userId: string;
  wallet: string | null;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  seeded: boolean;
  addresses: string[];
  quantity: string | null;
  thesisId: string | null;
  postId: string | null;
  thesisPositionId: string | null;
  body: string | null;
  thesisCreatedAt: number | null;
  likeCount: number | null;
  replyCount: number | null;
  viewCount: number | null;
};

export type TokenHolderUserFilter =
  | { wallets: string[] }
  | { holding: true; thesisOnly: boolean; followed?: string[]; limit: number };

const userAddresses = (
  addresses: string[],
) => sql`(u.wallet_address = any(${sql.param(addresses)}::text[]) or exists(
  select 1 from wallets w where w.user_id = u.id and w.chain_type = 'solana'
  and w.address = any(${sql.param(addresses)}::text[])
))`;

export class PgTokenActivityRepository {
  constructor(private readonly db: Db) {}

  async getToken(mint: string) {
    const [token] = await this.db.select().from(tokens).where(eq(tokens.mint, mint));
    return token;
  }

  async getPosition(userId: string, mint: string) {
    const [row] = await this.db
      .select({ position: positions, seeded: users.demo })
      .from(positions)
      .innerJoin(users, eq(users.id, positions.userId))
      .where(and(eq(positions.userId, userId), eq(positions.mint, mint)));
    return row;
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
        seeded: users.demo,
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

  async holderUsers(mint: string, filter: TokenHolderUserFilter) {
    const where =
      "wallets" in filter
        ? userAddresses(filter.wallets)
        : sql.join(
            [
              sql`p.quantity > 0`,
              filter.thesisOnly ? sql`t.thesis_id is not null` : undefined,
              filter.followed ? userAddresses(filter.followed) : undefined,
            ].filter((part) => part !== undefined),
            sql` and `,
          );
    const limit = "wallets" in filter ? filter.wallets.length : filter.limit;
    if (!limit) return [];
    const rows = await this.db.execute<TokenHolderUserRow>(sql`
      select u.id as "userId", coalesce(u.wallet_address, (
          select w.address from wallets w where w.user_id = u.id and w.chain_type = 'solana'
          order by w.is_primary desc, w.address limit 1
        )) as wallet,
        u.handle, u.display_name as "displayName", u.avatar_url as "avatarUrl", u.demo as seeded,
        array_remove(array_prepend(u.wallet_address, coalesce((
          select array_agg(w.address) from wallets w where w.user_id = u.id and w.chain_type = 'solana'
        ), '{}'::text[])), null) as addresses,
        p.quantity::text as quantity,
        t.thesis_id as "thesisId", t.post_id as "postId", t.position_id as "thesisPositionId",
        t.body, t.created_at as "thesisCreatedAt", t.like_count as "likeCount",
        t.reply_count as "replyCount", t.view_count as "viewCount"
      from users u
      left join positions p on p.user_id = u.id and p.mint = ${mint}
      left join lateral (
        select th.id::text as thesis_id, c.id::text as post_id, th.position_id::text as position_id, c.body,
          floor(extract(epoch from c.created_at))::float8 as created_at,
          (select count(*)::int from social_reactions r where r.post_id = c.id) as like_count,
          (select count(*)::int from comments reply where reply.thesis_id = th.id and reply.kind = 'comment') as reply_count,
          th.view_count::float8 as view_count
        from theses th join comments c on c.thesis_id = th.id and c.kind = 'thesis'
        where th.user_id = u.id and th.mint = ${mint}
        order by c.created_at desc, c.id desc limit 1
      ) t on true
      where ${where}
      order by p.quantity desc nulls last, u.id
      limit ${limit}
    `);
    return [...rows];
  }

  tradesFor(userIds: string[]) {
    if (!userIds.length) return Promise.resolve([]);
    return this.db.select().from(trades).where(inArray(trades.userId, userIds));
  }
}
