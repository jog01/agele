import { z } from "zod";
import { formatDecimal } from "../lib/decimal";
import { AppError, badRequest, notFound, unauthorized } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { PgSocialRepository } from "../repositories/social.repository";
import type { UserWithWallets } from "../repositories/user.repository";
import type {
  CommentBody,
  FeedDiscussionParam,
  FeedItemDto,
  FeedQuery,
  LeaderboardEntryDto,
  LeaderboardWindowValue,
} from "../schemas/social";
import { cachePositionQuotes, type PositionQuote } from "./market-data/position-quotes";
import { positionEpisodes } from "./position-episodes";
import { decodeCursor, encodeCursor, type FeedCursor } from "./social/cursor";
import type { TokenService } from "./token.service";

const cursorSchema = z.object({ createdAt: z.number().int().min(0).max(253402300799), id: z.uuid() });
const usableQuote = (value?: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
function decodeSocialCursor(value: string) {
  const result = cursorSchema.safeParse(decodeCursor(value));
  if (!result.success) throw badRequest("Invalid social cursor");
  return result.data;
}

export type TextModeration = (text: string) => void | Promise<void>;
type Discussion = z.infer<typeof FeedDiscussionParam>["key"];
const moderateText: TextModeration = (text) => {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, "");
  if (
    /(?:discord\.gg\/|discord\.com\/invite\/|t\.me\/|chat\.whatsapp\.com\/|signal\.group\/)/.test(normalized)
  ) {
    throw new AppError(422, "social_moderation", "External chat invites are not allowed");
  }
};

export class SocialService {
  constructor(
    private readonly repository: PgSocialRepository,
    private readonly tokens: TokenService,
    private readonly follows: FollowRepository,
    private readonly ranks: (window: LeaderboardWindowValue, limit: number) => Promise<LeaderboardEntryDto[]>,
    private readonly moderate: TextModeration = moderateText,
    private readonly positionQuote: PositionQuote = (mint) => tokens.getToken(mint),
  ) {}

  async leaderboard(window: LeaderboardWindowValue, limit: number, viewerId?: string) {
    const rows = await this.ranks(window, limit);
    if (!viewerId) return rows.map(({ isFollowing: _, ...row }) => row);
    const wallets = new Set(await this.follows.listWallets(viewerId));
    return rows.map((row) => ({ ...row, isFollowing: wallets.has(row.wallet) }));
  }

  async feed(input: z.infer<typeof FeedQuery>, viewerId?: string) {
    if (input.scope === "following" && !viewerId) throw unauthorized("Missing bearer token");
    if (
      input.minMarketCapUsd !== undefined &&
      input.maxMarketCapUsd !== undefined &&
      input.minMarketCapUsd > input.maxMarketCapUsd
    )
      throw badRequest("Invalid market cap range");
    let cursor = input.cursor === undefined ? undefined : decodeSocialCursor(input.cursor);
    const wallets = input.scope === "following" ? await this.follows.listWallets(viewerId!) : undefined;
    const types = input.types?.split(",");
    const quote = cachePositionQuotes(this.positionQuote);
    const portfolios = new Map<string, Promise<number | null>>();
    const portfolioValue = (userId: string) => {
      const cached = portfolios.get(userId);
      if (cached) return cached;
      const result = this.repository.holdings(userId).then(async (holdings) => {
        const values = await Promise.all(
          holdings
            .filter((holding) => Number(holding.quantity) > 0)
            .map(async (holding) => {
              const token = await quote(holding.mint, holding.seeded);
              const price = usableQuote(token?.priceUsd);
              return price === null ? null : Number(holding.quantity) * price;
            }),
        );
        return values.reduce<number | null>(
          (sum, value) => (sum === null || value === null ? null : sum + value),
          0,
        );
      });
      portfolios.set(userId, result);
      return result;
    };
    const episodes = new Map<string, Promise<ReturnType<typeof positionEpisodes>>>();
    const getEpisodes = (userId: string, mint: string) => {
      const key = `${userId}:${mint}`;
      const cached = episodes.get(key);
      if (cached) return cached;
      const result = this.repository.tradeHistory(userId, mint).then(positionEpisodes);
      episodes.set(key, result);
      return result;
    };
    const systemTypes =
      types?.filter((type): type is SystemType => type === "price-spike" || type === "new-listing") ?? [];
    const withSystem =
      systemTypes.length > 0 &&
      input.scope === "global" &&
      !input.wallet &&
      input.minSizeUsd === undefined &&
      input.minPortfolioUsd === undefined &&
      input.minPriceSinceFirstBuyPct === undefined;
    const withSocial = !types || types.some((type) => !(systemTypes as string[]).includes(type));
    const inMarketCap = (marketCapUsd: number | null) =>
      !(
        (input.minMarketCapUsd !== undefined &&
          (marketCapUsd === null || marketCapUsd < input.minMarketCapUsd)) ||
        (input.maxMarketCapUsd !== undefined &&
          (marketCapUsd === null || marketCapUsd > input.maxMarketCapUsd))
      );
    const items: FeedItemDto[] = [];
    for (;;) {
      const empty = { items: [], nextCursor: null };
      const [batch, system] = await Promise.all([
        withSocial
          ? this.repository.feed({ ...input, wallets, cursor, limit: input.limit, viewerId, types })
          : empty,
        withSystem
          ? this.repository.systemFeed({ cursor, limit: input.limit, mint: input.mint, types: systemTypes })
          : { ...empty, source: "demo" as const },
      ]);
      const boundary = [batch, system]
        .filter((stream) => stream.nextCursor)
        .map((stream) => stream.items.at(-1)!)
        .reduce<FeedCursor | null>(
          (max, key) => (max === null || compareKeys(key, max) > 0 ? key : max),
          null,
        );
      const fresh = (key: FeedCursor) => boundary === null || compareKeys(key, boundary) >= 0;
      const systemItems = system.items.filter(fresh).map(({ kind, ...row }): FeedItemDto | null => {
        if (!inMarketCap(row.marketCapUsd)) return null;
        const base = {
          id: row.id,
          mint: row.mint,
          symbol: row.symbol,
          imageUrl: row.imageUrl,
          createdAt: row.createdAt,
          source: system.source === "demo" ? ("demo" as const) : ("indexed" as const),
          marketCapUsd: row.marketCapUsd,
        };
        return kind === "price-spike"
          ? {
              ...base,
              kind,
              eventType: kind,
              priceChangePct: row.priceChangePct,
              windowSeconds: 15 * 60,
              priceUsd: row.priceUsd,
              volumeUsd: row.volumeUsd,
            }
          : { ...base, kind, eventType: kind, venue: row.venue, creator: row.creator };
      });
      const socialItems = await Promise.all(
        batch.items.filter(fresh).map(async ({ userId, ...item }) => {
          const seeded = item.source === "demo";
          const token = await quote(item.mint, seeded);
          item.marketCapUsd = usableQuote(token?.marketCapUsd);
          if (!inMarketCap(item.marketCapUsd)) return null;
          if (item.kind === "milestone") {
            const tradeId = item.discussionKey.slice("milestone:".length);
            item.positionId =
              (await getEpisodes(userId, item.mint)).find((entry) =>
                entry.fills.some((fill) => fill.id === tradeId),
              )?.id ?? null;
          }
          if (item.kind === "trade") {
            const episode = (await getEpisodes(userId, item.mint)).find((entry) =>
              entry.fills.some((fill) => fill.id === item.id),
            );
            if (episode) {
              item.positionId = episode.id;
              const firstPrice = Number(episode.fills[0]!.priceUsd);
              const price = usableQuote(token?.priceUsd);
              item.priceSinceFirstBuyPct =
                price !== null && firstPrice > 0 ? (price / firstPrice - 1) * 100 : null;
              if (item.side === "buy" && episode.fills[0]?.id !== item.id) item.eventType = "increased";
              if (episode.closedAt && episode.fills.at(-1)?.id === item.id) {
                item.eventType = "closed";
                item.realizedPnlUsd = Number(formatDecimal(episode.realizedPnl));
              }
            }
          }
          if (types && !types.includes(item.eventType)) return null;
          if (
            input.minPriceSinceFirstBuyPct !== undefined &&
            (item.kind !== "trade" ||
              item.priceSinceFirstBuyPct === null ||
              item.priceSinceFirstBuyPct < input.minPriceSinceFirstBuyPct)
          )
            return null;
          if (input.minPortfolioUsd !== undefined) {
            const value = await portfolioValue(userId);
            if (value === null || value < input.minPortfolioUsd) return null;
          }
          return item;
        }),
      );
      const merged = [...socialItems, ...systemItems]
        .filter((item): item is FeedItemDto => item !== null)
        .sort((a, b) => compareKeys(b, a));
      for (const item of merged) {
        if (items.length === input.limit) return { items, nextCursor: encodeCursor(items.at(-1)!) };
        items.push(item);
      }
      if (!boundary) return { items, nextCursor: null };
      cursor = { createdAt: boundary.createdAt, id: boundary.id };
    }
  }

  async follow(viewer: UserWithWallets, wallet: string) {
    if (viewer.walletAddress === wallet || viewer.wallets.some((owned) => owned.address === wallet)) {
      throw badRequest("Cannot follow your own wallet");
    }
    await this.follows.follow(viewer.id, wallet);
  }

  async unfollow(viewerId: string, wallet: string) {
    await this.follows.unfollow(viewerId, wallet);
  }

  async comments(mint: string, limit: number, cursor?: string, viewerId?: string) {
    const boundary = cursor === undefined ? undefined : decodeSocialCursor(cursor);
    if (!(await this.repository.hasToken(mint))) await this.tokens.getToken(mint);
    return this.repository.listPosts(mint, limit, boundary, viewerId);
  }

  async post(
    viewer: UserWithWallets,
    mint: string,
    kind: "thesis" | "comment",
    input: { body: string; position: "long" | "short" | "none"; positionId?: string; parentId?: string },
  ) {
    await this.moderate(input.body);
    const post = { userId: viewer.id, mint, kind, body: input.body, position: input.position };
    if (kind === "thesis") {
      const episodes = positionEpisodes(await this.repository.tradeHistory(viewer.id, mint));
      const episode = input.positionId ? episodes.find(({ id }) => id === input.positionId) : episodes.at(-1);
      if (!episode) throw notFound("Position");
      const wallet =
        episode.fills[0]?.walletAddress ??
        viewer.walletAddress ??
        viewer.wallets
          .filter((item) => item.chainType === "solana")
          .sort((a, b) => a.address.localeCompare(b.address))[0]?.address;
      if (!wallet) throw badRequest("Link a Solana wallet before posting a thesis");
      if (episode.closedAt && Date.now() - episode.closedAt.getTime() > 3 * 60 * 60 * 1_000) {
        throw new AppError(
          409,
          "thesis_window_closed",
          "Theses can only be updated up to three hours after close",
        );
      }
      return this.repository.createPost(post, { wallet, positionId: episode.id });
    }
    if (input.parentId) {
      const parent = await this.repository.getPost(input.parentId);
      if (!parent || parent.mint !== mint || parent.discussionKey) throw notFound("Parent post");
      return this.repository.createPost({ ...post, parentId: parent.id, thesisId: parent.thesisId });
    }
    if (!(await this.repository.hasToken(mint)))
      await this.repository.cacheToken(await this.tokens.getToken(mint));
    return this.repository.createPost(post);
  }

  async thesisThread(mint: string, thesisId: string, limit: number, cursor?: string, viewerId?: string) {
    const thread = await this.repository.thesisThread(
      mint,
      thesisId,
      limit,
      cursor === undefined ? undefined : decodeSocialCursor(cursor),
      viewerId,
    );
    if (!thread) throw notFound("Thesis");
    return thread;
  }

  async pin(postId: string, viewerId: string, pinned: boolean) {
    const thesisId = await this.repository.ownedVersion(postId, viewerId);
    if (!thesisId) throw notFound("Thesis version");
    await this.repository.setPinned(thesisId, postId, pinned);
  }

  async recordThesisView(mint: string, thesisId: string, viewerKey: string) {
    const result = await this.repository.recordThesisView(mint, thesisId, viewerKey);
    if (!result) throw notFound("Thesis");
    return result;
  }

  async react(postId: string, viewerId: string, liked: boolean) {
    if (!(await this.repository.getPost(postId))) throw notFound("Post");
    await this.repository.setReaction(postId, viewerId, liked);
  }

  private async feedDiscussion({ key, target }: Discussion) {
    const mint = await this.repository.discussionMint(target);
    if (!mint) throw notFound("Feed activity");
    return { key, mint };
  }

  async feedReplies(discussion: Discussion, limit: number, cursor?: string, viewerId?: string) {
    const boundary = cursor === undefined ? undefined : decodeSocialCursor(cursor);
    const { key } = await this.feedDiscussion(discussion);
    return this.repository.discussionReplies(key, limit, boundary, viewerId);
  }

  async replyToFeed(discussion: Discussion, userId: string, input: z.infer<typeof CommentBody>) {
    await this.moderate(input.body);
    const { key, mint } = await this.feedDiscussion(discussion);
    if (input.parentId) {
      const parent = await this.repository.getPost(input.parentId);
      if (parent?.discussionKey !== key) throw notFound("Parent post");
    }
    return this.repository.createPost({ ...input, userId, mint, discussionKey: key, kind: "comment" });
  }

  async reactToFeed(discussion: Discussion, userId: string, liked: boolean) {
    await this.repository.setFeedReaction(await this.feedDiscussion(discussion), userId, liked);
  }
}

function compareKeys(a: FeedCursor, b: FeedCursor) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

type SystemType = "price-spike" | "new-listing";
