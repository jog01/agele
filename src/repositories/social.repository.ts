import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { AppError } from "../lib/errors";
import { comments, reactions, theses, tokens, trades, users } from "../models";
import type { CommentDto, FeedItemDto } from "../schemas/social";
import type { TokenDto } from "../schemas/token";
import { encodeCursor, type FeedCursor } from "../services/social/cursor";

type PostInput = Pick<
  typeof comments.$inferInsert,
  "userId" | "mint" | "kind" | "body" | "position" | "thesisId" | "parentId"
>;
type FeedRow = Omit<CommentDto, "kind"> & {
  kind: FeedItemDto["kind"];
  side: "buy" | "sell";
  amountUsd: number;
  positionId: string | null;
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

function before(time: typeof postTime, id: typeof postTime, cursor?: FeedCursor) {
  return cursor
    ? sql`and (${time}, ${id}) < (to_timestamp(${cursor.createdAt}) at time zone 'UTC', ${cursor.id}::uuid)`
    : sql.empty();
}

function pageCursor(rows: { createdAt: number; id: string }[], limit: number) {
  return rows.length > limit ? encodeCursor(rows[limit - 1]!) : null;
}

export class PgSocialRepository {
  constructor(private readonly db: Db) {}

  async feed(input: { wallets?: string[]; cursor?: FeedCursor; limit: number; viewerId?: string }) {
    const { wallets, cursor, limit, viewerId } = input;
    if (wallets?.length === 0) return { items: [], nextCursor: null };
    const followed = wallets
      ? sql`and (
        u.wallet_address = any(${sql.param(wallets)}::text[]) or exists (
          select 1 from wallets w where w.user_id = u.id and w.chain_type = 'solana'
          and w.address = any(${sql.param(wallets)}::text[])
        )
      )`
      : sql.empty();
    const rows = await this.db.execute<FeedRow>(sql`
      with page as (
        (select t.id, t.mint, t.user_id, 'trade' as kind, null::text as body,
          'none' as position, t.side, t.quote_amount_usd::float8 as "amountUsd", ${tradeTime} as at,
          null::uuid as "thesisId", false as pinned
         from trades t join users u on u.id = t.user_id
         where ${wallet} is not null ${followed} ${before(tradeTime, sql`t.id`, cursor)}
         order by at desc, t.id desc limit ${limit + 1})
        union all
        (select p.id, p.mint, p.user_id, 'thesis', p.body,
          p.position::text, null, null, ${postTime} as at, p.thesis_id, p.pinned
         from comments p join users u on u.id = p.user_id
         where p.kind = 'thesis' and ${wallet} is not null ${followed} ${before(postTime, sql`p.id`, cursor)}
         order by at desc, p.id desc limit ${limit + 1})
        order by at desc, id desc limit ${limit + 1}
      )
      select page.*, ${seconds} as "createdAt", ${wallet} as wallet, ${handle} as handle,
        ${source} as source, u.avatar_url as "avatarUrl", token.symbol, token.image_url as "imageUrl",
        th.position_id as "positionId",
        (select count(*)::int from social_reactions r where r.post_id = page.id and page.kind = 'thesis') as likes,
        (select count(*)::int from comments replies where replies.thesis_id = page."thesisId" and replies.kind = 'comment') as "replyCount"
        ${viewerId ? sql`, exists(select 1 from social_reactions r where r.post_id = page.id and r.user_id = ${viewerId}) as "likedByMe"` : sql.empty()}
      from page join users u on u.id = page.user_id
      join tokens token on token.mint = page.mint
      left join theses th on th.id = page."thesisId"
      order by page.at desc, page.id desc
    `);
    const items = rows.slice(0, limit).map((row): FeedItemDto => {
      const { id, wallet, mint, handle, source, avatarUrl, position, kind, symbol, imageUrl } = row;
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
      };
      return kind === "thesis"
        ? {
            ...base,
            kind,
            body: row.body,
            likes: row.likes,
            likedByMe: row.likedByMe,
            replyCount: row.replyCount,
            thesisId: row.thesisId!,
            positionId: row.positionId!,
            pinned: row.pinned,
          }
        : { ...base, kind, side: row.side, amountUsd: row.amountUsd };
    });
    return { items, nextCursor: pageCursor(rows, limit) };
  }

  private async readPosts(input: {
    mint?: string;
    id?: string;
    thesisId?: string;
    viewerId?: string;
    cursor?: FeedCursor;
    limit: number;
  }) {
    const { mint, id, thesisId, viewerId, cursor, limit } = input;
    return this.db.execute<CommentDto>(sql`
      select p.id, p.mint, p.body, p.position, p.kind, p.thesis_id as "thesisId", p.parent_id as "parentId", p.pinned,
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
      ${before(postTime, sql`p.id`, cursor)}
      order by ${postTime} desc, p.id desc limit ${limit}
    `);
  }

  async listPosts(mint: string, limit: number, cursor?: FeedCursor, viewerId?: string) {
    const rows = await this.readPosts({ mint, limit: limit + 1, cursor, viewerId });
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
        const identity = { ...episode, mint: input.mint, userId: input.userId };
        await tx.insert(theses).values(identity).onConflictDoNothing();
        const [thesis] = await tx
          .select({ id: theses.id })
          .from(theses)
          .where(
            and(
              eq(theses.wallet, episode.wallet),
              eq(theses.mint, input.mint),
              eq(theses.positionId, episode.positionId),
            ),
          );
        thesisId = thesis!.id;
      }
      const [row] = await tx
        .insert(comments)
        .values({ ...input, thesisId })
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
}
