import { and, asc, count, countDistinct, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { follows, tokens, trades, users, wallets } from "../models";
import type { FeedCursor } from "../services/social/cursor";

type Connection = {
  id: string;
  wallet: string | null;
  handle: string | null;
  avatarUrl: string | null;
  createdAt: number;
  isFollowing: boolean | null;
};
const canonical = sql`coalesce(u.wallet_address, (
  select w.address from wallets w where w.user_id = u.id and w.chain_type = 'solana'
  order by w.is_primary desc, w.address limit 1
))`;
const matches = (
  addresses: string[],
) => sql`(u.wallet_address = any(${sql.param(addresses)}::text[]) or exists(
  select 1 from wallets w where w.user_id = u.id and w.chain_type = 'solana'
  and w.address = any(${sql.param(addresses)}::text[])
))`;
const followerSet = (addresses: string[]) => sql`select follower_id as id,
  floor(extract(epoch from max(created_at)))::float8 as time from follows
  where followee_wallet = any(${sql.param(addresses)}::text[]) group by follower_id`;
const before = (cursor?: FeedCursor) =>
  cursor ? sql`where (edge.time, edge.id) < (${cursor.createdAt}, ${cursor.id})` : sql.empty();

export class PgTraderRepository {
  constructor(private readonly db: Db) {}

  async findByWallet(wallet: string) {
    const [linked] = await this.db
      .select({ user: users })
      .from(wallets)
      .innerJoin(users, eq(users.id, wallets.userId))
      .where(and(eq(wallets.address, wallet), eq(wallets.chainType, "solana")))
      .limit(1);
    if (linked) return linked.user;
    const [user] = await this.db.select().from(users).where(eq(users.walletAddress, wallet)).limit(1);
    return user;
  }

  search(query: string, limit: number) {
    const prefix = query.replace(/^@/, "").toLowerCase();
    const exact = sql`(u.wallet_address = ${query} or exists (
      select 1 from wallets w where w.user_id = u.id and w.chain_type = 'solana' and w.address = ${query}
    ))`;
    const resultWallet = sql`coalesce(alias.address, ${canonical})`;
    return this.db.execute<{
      wallet: string;
      handle: string;
      displayName: string | null;
      avatarUrl: string | null;
      source: "demo" | "indexed";
    }>(sql`
      select result.wallet, result.handle,
        result.display_name as "displayName", result.avatar_url as "avatarUrl",
        case when result.demo then 'demo' else 'indexed' end as source
      from (
        select ${resultWallet} as wallet, coalesce(u.handle, left(${resultWallet}, 8)) as handle,
          u.display_name, u.avatar_url, u.demo, ${exact} as exact
        from users u
        left join lateral (
          select w.address from wallets w
          where u.wallet_address is null and u.handle is null
            and w.user_id = u.id and w.chain_type = 'solana'
            and (w.address = ${query} or (
              ${prefix} <> '' and starts_with(lower(left(w.address, 8)), ${prefix})
            ))
          order by (w.address = ${query}) desc, (lower(left(w.address, 8)) = ${prefix}) desc,
            w.is_primary desc, w.address
          limit 1
        ) alias on true
      ) result
      where result.wallet is not null
      and (result.exact or (${prefix} <> '' and (
        starts_with(lower(result.handle), ${prefix}) or starts_with(lower(result.display_name), ${prefix})
      )))
      order by result.exact desc nulls last, (lower(result.handle) = ${prefix}) desc, result.handle, result.wallet
      limit ${limit}
    `);
  }

  async linkedAddresses(userId: string) {
    const rows = await this.db
      .select({ address: wallets.address })
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.chainType, "solana")));
    return rows.map((row) => row.address);
  }

  async followerCount(addresses: string[]) {
    const [row] = await this.db
      .select({ value: countDistinct(follows.followerId) })
      .from(follows)
      .where(inArray(follows.followeeWallet, addresses));
    return row!.value;
  }

  async followingCount(userId: string) {
    const [row] = await this.db
      .select({ value: count() })
      .from(follows)
      .where(eq(follows.followerId, userId));
    return row!.value;
  }

  tradeHistory(userId: string, mint?: string) {
    return this.db
      .select()
      .from(trades)
      .where(and(eq(trades.userId, userId), mint ? eq(trades.mint, mint) : undefined))
      .orderBy(asc(trades.executedAt), asc(trades.id));
  }

  async token(mint: string) {
    const [token] = await this.db.select().from(tokens).where(eq(tokens.mint, mint));
    return token;
  }

  tokens(mints: string[]) {
    return this.db.select().from(tokens).where(inArray(tokens.mint, mints));
  }

  async mutualFollowers(addresses: string[], followed: string[]) {
    if (!followed.length) return { count: 0, preview: [] };
    const rows = await this.db.execute<{
      wallet: string | null;
      avatarUrl: string | null;
      count: number;
    }>(sql`
      select ${canonical} as wallet, u.avatar_url as "avatarUrl", count(*) over()::int as count
      from (${followerSet(addresses)}) edge join users u on u.id = edge.id
      where ${matches(followed)} order by edge.time desc, edge.id desc limit 3
    `);
    return {
      count: rows[0]?.count ?? 0,
      preview: rows.map(({ wallet, avatarUrl }) => ({ wallet, avatarUrl })),
    };
  }

  followers(addresses: string[], followed: string[] | undefined, limit: number, cursor?: FeedCursor) {
    return this.db.execute<Connection>(sql`
      select edge.id::text, ${canonical} as wallet, u.handle, u.avatar_url as "avatarUrl",
        edge.time as "createdAt", ${followed ? matches(followed) : sql`null`} as "isFollowing"
      from (${followerSet(addresses)}) edge join users u on u.id = edge.id
      ${before(cursor)} order by edge.time desc, edge.id desc limit ${limit}
    `);
  }

  following(userId: string, followed: string[] | undefined, limit: number, cursor?: FeedCursor) {
    return this.db.execute<Connection>(sql`
      select edge.id, edge.id as wallet, u.handle, u.avatar_url as "avatarUrl",
        edge.time as "createdAt",
        ${followed ? sql`coalesce(${matches(followed)}, false) or edge.id = any(${sql.param(followed)}::text[])` : sql`null`} as "isFollowing"
      from (select followee_wallet as id, floor(extract(epoch from created_at))::float8 as time
        from follows where follower_id = ${userId}) edge
      left join lateral (
        select candidate.* from users candidate
        where candidate.wallet_address = edge.id or candidate.id = (
          select w.user_id from wallets w where w.address = edge.id and w.chain_type = 'solana'
        )
        order by (candidate.wallet_address = edge.id) desc nulls last limit 1
      ) u on true
      ${before(cursor)} order by edge.time desc, edge.id desc limit ${limit}
    `);
  }
}
