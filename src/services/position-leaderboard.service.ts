import { formatDecimal } from "../lib/decimal";
import { badRequest } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { PositionLeaderboardRepository } from "../repositories/position-leaderboard.repository";
import type {
  InvestedBucketValue,
  PositionsLeaderboardEntryDto,
  PositionsLeaderboardWindowValue,
} from "../schemas/social";
import { positionEpisodes, weightedCap } from "./position-episodes";

const DAY = 86_400_000;
const WINDOW_MS: Record<PositionsLeaderboardWindowValue, number | null> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  all: null,
};
/** Inclusive lower and exclusive upper bound of total bought USD. */
export const INVESTED_BUCKETS: Record<InvestedBucketValue, [number, number]> = {
  lt100: [0, 100],
  "100-1k": [100, 1_000],
  "1k-10k": [1_000, 10_000],
  "10k-100k": [10_000, 100_000],
  gt100k: [100_000, Number.POSITIVE_INFINITY],
};

type Row = Omit<PositionsLeaderboardEntryDto, "rank" | "isFollowing"> & { wallets: string[] };
interface Ranking {
  computedAt: number;
  rows: Row[];
}
type Cursor = { pnl: number; id: string };

export interface PositionsLeaderboardFilter {
  window: PositionsLeaderboardWindowValue;
  invested?: InvestedBucketValue;
  minHoldSeconds?: number;
  maxHoldSeconds?: number;
  cursor?: string;
  limit: number;
}

const unix = (time: number) => Math.floor(time / 1000);
const number = (value: bigint) => Number(formatDecimal(value));
const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify({ pnl: cursor.pnl, id: cursor.id })).toString("base64url");
function decodeCursor(value: string): Cursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Number.isFinite(cursor?.pnl) || typeof cursor.id !== "string" || encodeCursor(cursor) !== value)
      throw new Error();
    return cursor;
  } catch {
    throw badRequest("Invalid leaderboard cursor");
  }
}
const after = (row: Row, cursor: Cursor) =>
  row.realizedPnlUsd < cursor.pnl || (row.realizedPnlUsd === cursor.pnl && row.positionId > cursor.id);

/**
 * Ranks closed position episodes (first buy until holdings return to zero) by realized USD PnL.
 * Each window's ranking is computed from stored fills and cached briefly; invested and hold-time
 * filters apply before ranks are numbered, and the keyset cursor pages through the filtered list.
 */
export class PositionLeaderboardService {
  private readonly cache = new Map<PositionsLeaderboardWindowValue, Promise<Ranking>>();

  constructor(
    private readonly repository: PositionLeaderboardRepository,
    private readonly follows: FollowRepository,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
  ) {}

  async leaderboard(filter: PositionsLeaderboardFilter, viewerId?: string) {
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const [ranking, followed] = await Promise.all([
      this.ranking(filter.window),
      viewerId ? this.follows.listWallets(viewerId) : undefined,
    ]);
    const [low, high] = filter.invested ? INVESTED_BUCKETS[filter.invested] : [0, Number.POSITIVE_INFINITY];
    const minHold = filter.minHoldSeconds ?? 0;
    const maxHold = filter.maxHoldSeconds ?? Number.POSITIVE_INFINITY;
    const followedWallets = followed ? new Set(followed) : undefined;
    const matching = ranking.rows.filter(
      (row) =>
        row.totalInvestedUsd >= low &&
        row.totalInvestedUsd < high &&
        row.holdSeconds >= minHold &&
        row.holdSeconds <= maxHold,
    );
    const start = cursor ? matching.findIndex((row) => after(row, cursor)) : 0;
    const page = start < 0 ? [] : matching.slice(start, start + filter.limit);
    const entries = page.map(
      ({ wallets, ...row }, index): PositionsLeaderboardEntryDto => ({
        ...row,
        rank: start + index + 1,
        ...(followedWallets ? { isFollowing: wallets.some((wallet) => followedWallets.has(wallet)) } : {}),
      }),
    );
    const last = page.at(-1);
    const more = start >= 0 && start + filter.limit < matching.length;
    return {
      entries,
      nextCursor: more && last ? encodeCursor({ pnl: last.realizedPnlUsd, id: last.positionId }) : null,
    };
  }

  private ranking(window: PositionsLeaderboardWindowValue) {
    const now = this.now();
    const cached = this.cache.get(window);
    if (!cached) return this.refresh(window, now);
    return cached.then((ranking) =>
      now - ranking.computedAt < this.ttlMs ? ranking : this.refresh(window, now),
    );
  }

  private refresh(window: PositionsLeaderboardWindowValue, now: number) {
    const pending = this.compute(window, now);
    this.cache.set(window, pending);
    pending.catch(() => {
      if (this.cache.get(window) === pending) this.cache.delete(window);
    });
    return pending;
  }

  private async compute(window: PositionsLeaderboardWindowValue, now: number): Promise<Ranking> {
    const span = WINDOW_MS[window];
    const since = span === null ? undefined : now - span;
    const fills = await this.repository.getFills(since === undefined ? undefined : new Date(since));
    const byUser = new Map<string, typeof fills>();
    for (const fill of fills) {
      const group = byUser.get(fill.userId) ?? [];
      group.push(fill);
      byUser.set(fill.userId, group);
    }
    const episodes = [...byUser.values()]
      .flatMap((group) => positionEpisodes(group))
      .filter(
        (episode) =>
          episode.closedAt &&
          episode.invested > 0n &&
          episode.closedAt.getTime() <= now &&
          (since === undefined || episode.closedAt.getTime() >= since),
      );
    const [traders, theses, tokens] = await Promise.all([
      this.repository.getTraders([...new Set(episodes.map((episode) => episode.fills[0]!.userId))]),
      this.repository.getTheses(episodes.map((episode) => episode.id)),
      this.repository.getTokens([...new Set(episodes.map((episode) => episode.mint))]),
    ]);
    const traderById = new Map(traders.map((trader) => [trader.id, trader]));
    const thesisByPosition = new Map(theses.map((thesis) => [thesis.positionId, thesis]));
    const tokenByMint = new Map(tokens.map((token) => [token.mint, token]));
    const rows: Row[] = [];
    for (const episode of episodes) {
      const trader = traderById.get(episode.fills[0]!.userId);
      const token = tokenByMint.get(episode.mint);
      if (!trader?.wallet || !token) continue;
      const totalInvestedUsd = number(episode.invested);
      const realizedPnlUsd = number(episode.realizedPnl);
      const thesis = thesisByPosition.get(episode.id);
      const openedAt = unix(episode.openedAt.getTime());
      const closedAt = unix(episode.closedAt!.getTime());
      rows.push({
        positionId: episode.id,
        trader: {
          wallet: trader.wallet,
          handle: trader.handle ?? trader.wallet.slice(0, 8),
          displayName: trader.displayName,
          avatarUrl: trader.avatarUrl,
        },
        token: { mint: token.mint, symbol: token.symbol, name: token.name, imageUrl: token.imageUrl },
        totalInvestedUsd,
        realizedPnlUsd,
        pnlPct: (100 * realizedPnlUsd) / totalInvestedUsd,
        avgEntryMarketCapUsd: weightedCap(episode.fills, "buy"),
        holdSeconds: Math.max(0, closedAt - openedAt),
        openedAt,
        closedAt,
        thesis: thesis
          ? { id: thesis.id, body: thesis.body, createdAt: unix(thesis.createdAt.getTime()) }
          : null,
        ...(trader.demo ? { source: "demo" as const } : {}),
        wallets: [trader.wallet, ...new Set(episode.fills.flatMap((fill) => fill.walletAddress ?? []))],
      });
    }
    return {
      computedAt: now,
      rows: rows.sort(
        (a, b) => b.realizedPnlUsd - a.realizedPnlUsd || a.positionId.localeCompare(b.positionId),
      ),
    };
  }
}
