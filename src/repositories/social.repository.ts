import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { AppError } from "../lib/errors";
import {
  comments,
  feedDiscussions,
  feedReactions,
  positions,
  reactions,
  theses,
  tokens,
  trades,
  users,
} from "../models";
import type { CommentDto, FeedDiscussionTarget, FeedItemDto } from "../schemas/social";
import type { TokenDto } from "../schemas/token";
import { encodeCursor, type FeedCursor } from "../services/social/cursor";

type PostInput = Pick<
  typeof comments.$inferInsert,
  "userId" | "mint" | "kind" | "body" | "position" | "thesisId" | "parentId" | "discussionKey"
>;
type FeedDiscussion = typeof feedDiscussions.$inferInsert;
type FeedRow = Omit<CommentDto, "kind"> & {
  kind: FeedItemDto["kind"];
  side: "buy" | "sell";
  amountUsd: number;
  tokenAmount: number;
  positionId: string | null;
  traderCount: number;
  realizedPnlUsd: number | null;
  userId: string;
  likeCount: number;
  viewerLiked: boolean;
};

const wallet = sql`coalesce(u.wallet_address, (
  select w.address from wallets w where w.user_id = u.id and w.chain_type = 'solana'
  order by w.is_primary desc, w.address limit 1
))`;
const postTime = sql`date_trunc('second', p.created_at at time zone 'UTC')`;
const tradeTime = sql`date_trunc('second', t.executed_at at time zone 'UTC')`;
const handle = sql`coalesce(u.handle, left(${wallet}, 8), 'Trader')`;
const source = sql`case when u.demo then 'demo' else 'indexed' end`;
const seconds = sql`extract(epoch from at)::float8`;
const milestone = sql`t.side = 'sell' and t.realized_pnl_usd >= 1000`;
const firstTrade = sql`not exists(select 1 from trades first where first.user_id = t.user_id
  and (first.executed_at, first.id) < (t.executed_at, t.id))`;

function before(time: typeof postTime, id: typeof postTime, cursor?: FeedCursor) {
  return cursor
    ? sql`and (${time}, ${id}) < (to_timestamp(${cursor.createdAt}) at time zone 'UTC', ${cursor.id}::uuid)`
    : sql.empty();
}

function pageCursor(rows: { createdAt: number; id: string }[], limit: number) {
  return rows.length > limit ? encodeCursor(rows[limit - 1]!) : null;
}

function eventId(key: ReturnType<typeof sql>) {
  const hash = sql`md5(${key})`;
  return sql`overlay(overlay(${hash} placing '5' from 13) placing '8' from 17)::uuid`;
}

export class PgSocialRepository {
  constructor(private readonly db: Db) {}

  async feed(input: {
    wallets?: string[];
    wallet?: string;
    mint?: string;
    cursor?: FeedCursor;
    limit: number;
    viewerId?: string;
    minSizeUsd?: number;
    types?: string[];
  }) {
    const { wallets, cursor, limit, viewerId, mint, minSizeUsd, types } = input;
    if (wallets?.length === 0) return { items: [], nextCursor: null };
    const matches = (addresses: string[]) => sql`(
        u.wallet_address = any(${sql.param(addresses)}::text[]) or exists (
          select 1 from wallets w where w.user_id = u.id and w.chain_type = 'solana'
          and w.address = any(${sql.param(addresses)}::text[])
        )
      )`;
    const followed = sql`
      ${wallets ? sql`and ${matches(wallets)}` : sql.empty()}
      ${input.wallet ? sql`and ${matches([input.wallet])}` : sql.empty()}
    `;
    const scopedMint = (column: ReturnType<typeof sql>) =>
      mint ? sql`and ${column} = ${mint}` : sql.empty();
    const bigEnough = (column: ReturnType<typeof sql>) =>
      minSizeUsd === undefined ? sql.empty() : sql`and ${column} >= ${minSizeUsd}`;
    const groupAt = sql`date_bin('5 minutes', t.executed_at, '1970-01-01T00:00:00Z') at time zone 'UTC'`;
    const eventAt = sql`groups.bucket + interval '5 minutes'`;
    const groupId = eventId(
      sql`'trade-group:' || groups.mint || ':' || groups.side || ':' || extract(epoch from groups.bucket)`,
    );
    const milestoneId = eventId(sql`'profit-milestone:' || t.id`);
    const newTraderKey = sql`'new-trader:' || t.user_id`;
    const newTraderId = eventId(newTraderKey);
    const enabled = (condition: boolean) => (condition ? sql.empty() : sql`and false`);
    const rows = await this.db.execute<FeedRow>(sql`
      with groups as (
        select t.mint, t.side, ${groupAt} as bucket,
          count(distinct t.user_id)::int as trader_count, sum(t.quote_amount_usd) as amount,
          (array_agg(t.user_id order by t.executed_at desc, t.id desc))[1] as user_id,
          bool_and(u.demo) as demo
        from trades t join users u on u.id = t.user_id
        where true ${enabled(!input.wallet && (types?.includes("multi-user") ?? false))} ${followed} ${scopedMint(sql`t.mint`)}
          and ${wallet} is not null and ${groupAt} + interval '5 minutes' <= now() at time zone 'UTC'
          ${cursor ? sql`and t.executed_at < to_timestamp(${cursor.createdAt})` : sql.empty()}
        group by 1, 2, 3 having count(distinct t.user_id) > 1
      ), page as (
        (select t.id, t.mint, t.user_id as "userId", 'trade' as kind, null::text as body,
          'none' as position, t.side, t.quote_amount_usd::float8 as "amountUsd", ${tradeTime} as at,
          null::uuid as "thesisId", false as pinned, t.token_amount::float8 as "tokenAmount",
          t.realized_pnl_usd::float8 as "realizedPnlUsd", null::int as "traderCount", null::boolean as demo,
          'trade:' || t.id as "discussionKey"
         from trades t join users u on u.id = t.user_id
         where ${wallet} is not null ${followed} ${scopedMint(sql`t.mint`)} ${bigEnough(sql`t.quote_amount_usd`)} ${before(tradeTime, sql`t.id`, cursor)}
           ${enabled(!types || types.some((type) => ["bought", "sold", "closed"].includes(type)))}
         order by at desc, t.id desc limit ${limit + 1})
        union all
        (select p.id, p.mint, p.user_id, 'thesis', p.body,
          p.position::text, null, null, ${postTime} as at, p.thesis_id, p.pinned, null, null, null, null, null
         from comments p join users u on u.id = p.user_id
         where p.kind = 'thesis' and ${wallet} is not null ${followed} ${scopedMint(sql`p.mint`)}
           ${enabled(minSizeUsd === undefined && (!types || types.includes("thesis")))} ${before(postTime, sql`p.id`, cursor)}
         order by at desc, p.id desc limit ${limit + 1})
        union all
        (select ${milestoneId}, t.mint, t.user_id, 'milestone', null, 'none', null,
         t.quote_amount_usd::float8, ${tradeTime} as at, null, false, null, t.realized_pnl_usd::float8, null, null,
         'milestone:' || t.id
         from trades t join users u on u.id = t.user_id
         where ${wallet} is not null ${followed} and ${milestone}
           ${enabled(types?.includes("milestone") ?? false)}
           ${scopedMint(sql`t.mint`)} ${bigEnough(sql`t.quote_amount_usd`)} ${before(tradeTime, milestoneId, cursor)}
         order by at desc, 1 desc limit ${limit + 1})
        union all
        (select ${newTraderId}, t.mint, t.user_id, 'new-trader', null, 'none', null,
         null, ${tradeTime} as at, null, false, null, null, null, null, ${newTraderKey}
         from trades t join users u on u.id = t.user_id
         where ${wallet} is not null ${followed} ${scopedMint(sql`t.mint`)}
           ${enabled(minSizeUsd === undefined && (types?.includes("new-trader") ?? false))} ${before(tradeTime, newTraderId, cursor)}
           and ${firstTrade}
         order by at desc, 1 desc limit ${limit + 1})
        union all
        (select ${groupId}, groups.mint, groups.user_id, 'multi-user', null, 'none', groups.side,
          groups.amount::float8, ${eventAt} as at, null, false, null, null, groups.trader_count, groups.demo,
          'multi-user:' || groups.mint || ':' || groups.side || ':' || extract(epoch from groups.bucket)::bigint
         from groups where true ${bigEnough(sql`groups.amount`)} ${before(eventAt, groupId, cursor)}
         order by at desc, 1 desc limit ${limit + 1})
        order by at desc, id desc limit ${limit + 1}
      )
      select page.*, ${seconds} as "createdAt", ${wallet} as wallet, ${handle} as handle,
        case when coalesce(page.demo, u.demo) then 'demo' else 'indexed' end as source,
        u.avatar_url as "avatarUrl", token.symbol, token.image_url as "imageUrl",
        th.position_id as "positionId",
        case when page.kind = 'thesis' then (select count(*)::int from social_reactions r where r.post_id = page.id)
          else (select count(*)::int from feed_reactions r where r.discussion_key = page."discussionKey")
        end as "likeCount",
        case when page.kind = 'thesis' then
          (select count(*)::int from comments replies where replies.thesis_id = page."thesisId" and replies.kind = 'comment')
          else (select count(*)::int from comments replies where replies.discussion_key = page."discussionKey")
        end as "replyCount",
        ${
          viewerId
            ? sql`case when page.kind = 'thesis' then
          exists(select 1 from social_reactions r where r.post_id = page.id and r.user_id = ${viewerId})
          else exists(select 1 from feed_reactions r where r.discussion_key = page."discussionKey" and r.user_id = ${viewerId})
        end`
            : sql`false`
        } as "viewerLiked"
      from page join users u on u.id = page."userId"
      join tokens token on token.mint = page.mint
      left join theses th on th.id = page."thesisId"
      order by page.at desc, page.id desc
    `);
    const items = rows.slice(0, limit).map((row): FeedItemDto & { userId: string } => {
      const { id, wallet, mint, handle, source, avatarUrl, position, kind, symbol, imageUrl, userId } = row;
      const base = {
        id,
        wallet: wallet!,
        mint,
        handle,
        source,
        avatarUrl,
        position,
        symbol,
        imageUrl,
        createdAt: row.createdAt,
        marketCapUsd: null,
        userId,
        likeCount: row.likeCount,
        replyCount: row.replyCount,
        viewerLiked: row.viewerLiked,
      };
      switch (kind) {
        case "thesis":
          return {
            ...base,
            kind,
            body: row.body,
            likes: row.likeCount,
            likedByMe: viewerId ? row.viewerLiked : undefined,
            thesisId: row.thesisId!,
            positionId: row.positionId!,
            pinned: row.pinned,
            eventType: kind,
          };
        case "trade":
          return {
            ...base,
            discussionKey: row.discussionKey!,
            kind,
            side: row.side,
            amountUsd: row.amountUsd,
            tokenAmount: row.tokenAmount,
            eventType: row.side === "buy" ? "bought" : "sold",
            positionId: null,
            priceSinceFirstBuyPct: null,
            realizedPnlUsd: row.side === "sell" ? row.realizedPnlUsd : null,
          };
        case "multi-user":
          return {
            ...base,
            discussionKey: row.discussionKey!,
            kind,
            eventType: kind,
            side: row.side,
            amountUsd: row.amountUsd,
            traderCount: row.traderCount,
          };
        case "milestone":
          return {
            ...base,
            discussionKey: row.discussionKey!,
            kind,
            eventType: kind,
            amountUsd: row.amountUsd,
            realizedPnlUsd: row.realizedPnlUsd!,
          };
        case "new-trader":
          return { ...base, discussionKey: row.discussionKey!, kind, eventType: kind };
        default:
          throw new Error(`Unknown feed item kind: ${kind}`);
      }
    });
    return { items, nextCursor: pageCursor(rows, limit) };
  }

  private async readPosts(input: {
    mint?: string;
    id?: string;
    thesisId?: string;
    discussionKey?: string;
    tokenOnly?: boolean;
    viewerId?: string;
    cursor?: FeedCursor;
    limit: number;
  }) {
    const { mint, id, thesisId, discussionKey, tokenOnly, viewerId, cursor, limit } = input;
    return this.db.execute<CommentDto>(sql`
      select p.id, p.mint, p.body, p.position, p.kind, p.thesis_id as "thesisId", p.parent_id as "parentId", p.pinned,
        p.discussion_key as "discussionKey",
        extract(epoch from ${postTime})::float8 as "createdAt",
        ${wallet} as wallet, ${handle} as handle, ${source} as source, u.avatar_url as "avatarUrl",
        token.symbol, token.image_url as "imageUrl",
        (select count(*)::int from social_reactions r where r.post_id = p.id) as likes,
        (select count(*)::int from comments replies where replies.parent_id = p.id) as "replyCount"
        ${viewerId ? sql`, exists(select 1 from social_reactions r where r.post_id = p.id and r.user_id = ${viewerId}) as "likedByMe"` : sql.empty()}
      from comments p join users u on u.id = p.user_id
      join tokens token on token.mint = p.mint
      where true
      ${mint ? sql`and p.mint = ${mint}` : sql.empty()}
      ${id ? sql`and p.id = ${id}` : sql.empty()}
      ${thesisId ? sql`and p.thesis_id = ${thesisId}` : sql.empty()}
      ${discussionKey ? sql`and p.discussion_key = ${discussionKey}` : sql.empty()}
      ${tokenOnly ? sql`and p.discussion_key is null` : sql.empty()}
      ${before(postTime, sql`p.id`, cursor)}
      order by ${postTime} desc, p.id desc limit ${limit}
    `);
  }

  async listPosts(mint: string, limit: number, cursor?: FeedCursor, viewerId?: string) {
    const rows = await this.readPosts({ mint, limit: limit + 1, cursor, viewerId, tokenOnly: true });
    return { comments: rows.slice(0, limit), nextCursor: pageCursor(rows, limit) };
  }

  async getPost(id: string, viewerId?: string) {
    return (await this.readPosts({ id, viewerId, limit: 1 }))[0];
  }

  tradeHistory(userId: string, mint: string) {
    return this.db
      .select()
      .from(trades)
      .where(and(eq(trades.userId, userId), eq(trades.mint, mint)))
      .orderBy(asc(trades.executedAt), asc(trades.id));
  }

  holdings(userId: string) {
    return this.db
      .select({ mint: positions.mint, quantity: positions.quantity, seeded: users.demo })
      .from(positions)
      .innerJoin(users, eq(users.id, positions.userId))
      .where(eq(positions.userId, userId));
  }

  async createPost(input: PostInput, episode?: { wallet: string; positionId: string }) {
    const id = await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
      const recent = await tx
        .select({ body: comments.body })
        .from(comments)
        .where(
          and(eq(comments.userId, input.userId), gte(comments.createdAt, new Date(Date.now() - 60_000))),
        );
      if (recent.length >= 5) throw new AppError(429, "post_rate_limit", "Too many posts; try again shortly");
      if (recent.some((post) => post.body.toLowerCase() === input.body.toLowerCase())) {
        throw new AppError(422, "social_moderation", "Duplicate post");
      }
      let thesisId = input.thesisId;
      if (episode) {
        const [thesis] = await tx
          .select({ id: theses.id })
          .from(theses)
          .where(
            and(
              eq(theses.userId, input.userId),
              eq(theses.mint, input.mint),
              eq(theses.positionId, episode.positionId),
            ),
          );
        if (thesis) thesisId = thesis.id;
        else {
          const [created] = await tx
            .insert(theses)
            .values({ ...episode, mint: input.mint, userId: input.userId })
            .returning({ id: theses.id });
          thesisId = created!.id;
        }
      }
      let mint = input.mint;
      if (input.discussionKey) {
        const [created] = await tx
          .insert(feedDiscussions)
          .values({ key: input.discussionKey, mint })
          .onConflictDoNothing()
          .returning({ mint: feedDiscussions.mint });
        const discussion =
          created ??
          (
            await tx
              .select({ mint: feedDiscussions.mint })
              .from(feedDiscussions)
              .where(eq(feedDiscussions.key, input.discussionKey))
          )[0]!;
        mint = discussion.mint;
      }
      const [row] = await tx
        .insert(comments)
        .values({ ...input, mint, thesisId })
        .returning({ id: comments.id });
      return row!.id;
    });
    return (await this.getPost(id, input.userId))!;
  }

  async thesisThread(mint: string, thesisId: string, limit: number, cursor?: FeedCursor, viewerId?: string) {
    const [thesis] = await this.db
      .select()
      .from(theses)
      .where(and(eq(theses.id, thesisId), eq(theses.mint, mint)));
    if (!thesis) return undefined;
    const [rows, pin] = await Promise.all([
      this.readPosts({ thesisId, limit: limit + 1, cursor, viewerId }),
      this.db
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.thesisId, thesisId), eq(comments.pinned, true))),
    ]);
    const { userId: _, ...publicThesis } = thesis;
    const pinned = pin[0] ? await this.getPost(pin[0].id, viewerId) : undefined;
    return {
      ...publicThesis,
      pinned: pinned ?? null,
      ...{ comments: rows.slice(0, limit), nextCursor: pageCursor(rows, limit) },
    };
  }

  async setPinned(thesisId: string, postId: string, pinned: boolean) {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: theses.id }).from(theses).where(eq(theses.id, thesisId)).for("update");
      if (pinned)
        await tx
          .update(comments)
          .set({ pinned: false })
          .where(and(eq(comments.thesisId, thesisId), eq(comments.pinned, true)));
      await tx.update(comments).set({ pinned }).where(eq(comments.id, postId));
    });
  }

  async ownedVersion(postId: string, userId: string) {
    const [post] = await this.db
      .select({ thesisId: comments.thesisId })
      .from(comments)
      .where(and(eq(comments.id, postId), eq(comments.userId, userId), eq(comments.kind, "thesis")));
    return post?.thesisId;
  }

  async hasToken(mint: string) {
    const [row] = await this.db.select({ mint: tokens.mint }).from(tokens).where(eq(tokens.mint, mint));
    return !!row;
  }

  async cacheToken({ mint, symbol, name, decimals, imageUrl }: TokenDto) {
    await this.db.insert(tokens).values({ mint, symbol, name, decimals, imageUrl }).onConflictDoNothing();
  }

  async setReaction(postId: string, userId: string, liked: boolean) {
    if (liked) await this.db.insert(reactions).values({ postId, userId }).onConflictDoNothing();
    else
      await this.db.delete(reactions).where(and(eq(reactions.postId, postId), eq(reactions.userId, userId)));
  }

  async discussionMint(target: FeedDiscussionTarget) {
    if (target.kind === "multi-user") {
      const { mint, side, bucket } = target;
      const [row] = await this.db.execute<{ mint: string }>(sql`
        select t.mint from trades t join users u on u.id = t.user_id
        where t.mint = ${mint} and t.side = ${side}
          and t.executed_at >= to_timestamp(${bucket}) and t.executed_at < to_timestamp(${bucket + 300})
          and to_timestamp(${bucket + 300}) <= now() and ${wallet} is not null
        group by t.mint having count(distinct t.user_id) > 1
      `);
      return row?.mint;
    }
    const predicate =
      target.kind === "new-trader"
        ? sql`t.user_id = ${target.id} and ${firstTrade}`
        : sql`t.id = ${target.id} ${target.kind === "milestone" ? sql`and ${milestone}` : sql.empty()}`;
    const [row] = await this.db.execute<{ mint: string }>(sql`
      select t.mint from trades t join users u on u.id = t.user_id
      where ${predicate} and ${wallet} is not null
    `);
    return row?.mint;
  }

  async discussionReplies(discussionKey: string, limit: number, cursor?: FeedCursor, viewerId?: string) {
    const rows = await this.readPosts({ discussionKey, limit: limit + 1, cursor, viewerId });
    return { comments: rows.slice(0, limit), nextCursor: pageCursor(rows, limit) };
  }

  async setFeedReaction(discussion: FeedDiscussion, userId: string, liked: boolean) {
    const discussionKey = discussion.key;
    if (liked) {
      await this.db.transaction(async (tx) => {
        await tx.insert(feedDiscussions).values(discussion).onConflictDoNothing();
        await tx.insert(feedReactions).values({ discussionKey, userId }).onConflictDoNothing();
      });
    } else {
      await this.db
        .delete(feedReactions)
        .where(and(eq(feedReactions.discussionKey, discussionKey), eq(feedReactions.userId, userId)));
    }
  }
}
