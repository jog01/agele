import type { EventPublisher } from "../events/bus";
import type { LeaderboardRepository } from "../repositories/leaderboard.repository";
import type { LeaderboardEntryDto, LeaderboardWindowValue } from "../schemas/social";
import type { MarketDataProvider } from "./market-data";
import { cachePositionQuotes, type PositionQuote } from "./market-data/position-quotes";
import {
  LEADERBOARD_WINDOWS,
  type LeaderboardSnapshot,
  type LeaderboardStore,
} from "./social/leaderboard-store";

const DAYS: Record<LeaderboardWindowValue, number> = { "24h": 1, "7d": 7, "30d": 30 };

export class LeaderboardService {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: LeaderboardRepository,
    private readonly store: LeaderboardStore,
    market: MarketDataProvider,
    private readonly hub: EventPublisher,
    private readonly now: () => number = Date.now,
    private readonly positionQuote: PositionQuote = (mint) => market.getToken(mint),
  ) {}

  private serialize(callback: () => Promise<void>) {
    const next = this.pending.then(callback);
    this.pending = next.catch(() => {});
    return next;
  }

  private async compute(now: number, userId?: string, includeInactive = false): Promise<LeaderboardSnapshot> {
    const [trades, positions] = await Promise.all([
      this.repository.getTrades(new Date(now - 30 * 86400000), userId),
      this.repository.getPositions(userId),
    ]);
    const unrealized = new Map<string, number>();
    const quote = cachePositionQuotes(this.positionQuote);
    const valued = await Promise.all(
      positions
        .filter((position) => Number(position.quantity) > 0)
        .map(async (position) => ({
          position,
          token: await quote(position.mint, position.seeded ?? false),
        })),
    );
    for (const { position, token } of valued) {
      const pnl =
        token && Number.isFinite(token.priceUsd) && token.priceUsd > 0
          ? Number(position.quantity) * token.priceUsd - Number(position.costBasisUsd)
          : 0;
      unrealized.set(position.userId, (unrealized.get(position.userId) ?? 0) + pnl);
    }
    const result: LeaderboardSnapshot = { "24h": [], "7d": [], "30d": [] };
    for (const window of LEADERBOARD_WINDOWS) {
      const grouped = new Map<string, typeof trades>();
      for (const trade of trades) {
        const time = trade.executedAt.getTime();
        if (time < now - DAYS[window] * 86400000 || time > now) continue;
        const group = grouped.get(trade.userId) ?? [];
        group.push(trade);
        grouped.set(trade.userId, group);
      }
      if (includeInactive && userId && !grouped.has(userId)) grouped.set(userId, []);
      for (const [id, group] of grouped) {
        const pnlUsd =
          group.reduce((sum, trade) => sum + Number(trade.realizedPnlUsd ?? 0), 0) +
          (unrealized.get(id) ?? 0);
        const buys = group
          .filter((trade) => trade.side === "buy")
          .reduce((sum, trade) => sum + Number(trade.quoteAmountUsd), 0);
        const sells = group.filter((trade) => trade.side === "sell");
        result[window].push({
          userId: id,
          pnlUsd,
          pnlPct: buys ? (pnlUsd / buys) * 100 : 0,
          volumeUsd: group.reduce((sum, trade) => sum + Number(trade.quoteAmountUsd), 0),
          trades: group.length,
          winRatePct: sells.length
            ? (sells.filter((trade) => Number(trade.realizedPnlUsd) > 0).length / sells.length) * 100
            : 0,
        });
      }
    }
    return result;
  }

  private sortRows(rows: LeaderboardSnapshot[LeaderboardWindowValue]) {
    return rows.sort((a, b) => b.pnlUsd - a.pnlUsd || a.userId.localeCompare(b.userId));
  }

  async userStats(userId: string, includeRanks: boolean | "database" = true) {
    const now = this.now();
    const [snapshot, ranks] = await Promise.all([
      this.compute(now, userId, true),
      includeRanks === "database" ? this.compute(now) : undefined,
    ]);
    const stats = async (window: LeaderboardWindowValue) => {
      const { userId: _, ...row } = snapshot[window][0]!;
      const rank = ranks
        ? this.sortRows(ranks[window]).findIndex((entry) => entry.userId === userId) + 1 || null
        : includeRanks && row.trades > 0
          ? await this.store.rank(window, userId)
          : null;
      return { ...row, rank };
    };
    const [day, week, month] = await Promise.all([stats("24h"), stats("7d"), stats("30d")]);
    return { "24h": day, "7d": week, "30d": month };
  }

  updateUser(userId: string) {
    return this.serialize(async () => {
      const now = this.now();
      const snapshot = await this.compute(now, userId);
      for (const window of LEADERBOARD_WINDOWS) {
        await this.store.update(window, userId, snapshot[window][0] ?? null);
        await this.hub.publish("leaderboard:global", { window, updatedAt: Math.floor(now / 1000) });
      }
    });
  }

  rebuild() {
    return this.serialize(async () => {
      const now = this.now();
      await this.store.replace(await this.compute(now));
      for (const window of LEADERBOARD_WINDOWS)
        await this.hub.publish("leaderboard:global", { window, updatedAt: Math.floor(now / 1000) });
    });
  }

  async leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]> {
    return this.entries(await this.store.top(window, limit));
  }

  async databaseLeaderboard(window: LeaderboardWindowValue, limit: number) {
    const snapshot = await this.compute(this.now());
    return this.entries(this.sortRows(snapshot[window]).slice(0, limit));
  }

  private async entries(rows: LeaderboardSnapshot[LeaderboardWindowValue]): Promise<LeaderboardEntryDto[]> {
    const users = new Map(
      (await this.repository.getUsers(rows.map((row) => row.userId))).map((user) => [user.id, user]),
    );
    return rows.map((row, index) => {
      const user = users.get(row.userId);
      const wallet = user?.wallet ?? "";
      const { userId: _, ...stats } = row;
      return {
        ...stats,
        rank: index + 1,
        wallet,
        handle: user?.handle ?? wallet.slice(0, 8),
        ...(user?.demo ? { source: "demo" as const } : {}),
      };
    });
  }
}
