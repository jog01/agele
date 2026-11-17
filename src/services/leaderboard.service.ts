import type { LeaderboardRepository } from "../repositories/leaderboard.repository";
import type { LeaderboardEntryDto, LeaderboardWindowValue } from "../schemas/social";
import type { WsHub } from "../ws/hub";
import type { MarketDataProvider } from "./market-data";
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
    private readonly market: MarketDataProvider,
    private readonly hub: Pick<WsHub, "publish">,
    private readonly now: () => number = Date.now,
  ) {}

  private serialize(callback: () => Promise<void>) {
    const next = this.pending.then(callback);
    this.pending = next.catch(() => {});
    return next;
  }

  private async compute(now: number, userId?: string): Promise<LeaderboardSnapshot> {
    const [trades, positions] = await Promise.all([
      this.repository.getTrades(new Date(now - 30 * 86400000), userId),
      this.repository.getPositions(userId),
    ]);
    const unrealized = new Map<string, number>();
    const prices = new Map(
      await Promise.all(
        [...new Set(positions.filter((p) => Number(p.quantity) > 0).map((p) => p.mint))].map(
          async (mint) => [mint, await this.market.getToken(mint)] as const,
        ),
      ),
    );
    for (const position of positions) {
      if (Number(position.quantity) <= 0) continue;
      const token = prices.get(position.mint);
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

  updateUser(userId: string) {
    return this.serialize(async () => {
      const now = this.now();
      const snapshot = await this.compute(now, userId);
      for (const window of LEADERBOARD_WINDOWS) {
        await this.store.update(window, userId, snapshot[window][0] ?? null);
        this.hub.publish("leaderboard:global", { window, updatedAt: Math.floor(now / 1000) });
      }
    });
  }

  rebuild() {
    return this.serialize(async () => {
      const now = this.now();
      await this.store.replace(await this.compute(now));
      for (const window of LEADERBOARD_WINDOWS)
        this.hub.publish("leaderboard:global", { window, updatedAt: Math.floor(now / 1000) });
    });
  }

  async leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]> {
    const rows = await this.store.top(window, limit);
    const users = new Map(
      (await this.repository.getUsers(rows.map((row) => row.userId))).map((user) => [user.id, user]),
    );
    return rows.map((row, index) => {
      const user = users.get(row.userId);
      const wallet = user?.wallet ?? "";
      const { userId: _, ...stats } = row;
      return { ...stats, rank: index + 1, wallet, handle: user?.handle ?? wallet.slice(0, 8) };
    });
  }
}
