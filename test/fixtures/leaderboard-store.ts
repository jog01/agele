import type { LeaderboardWindowValue } from "../../src/schemas/social";
import type {
  LeaderboardRow,
  LeaderboardSnapshot,
  LeaderboardStore,
} from "../../src/services/social/leaderboard-store";

export class MemoryLeaderboard implements LeaderboardStore {
  private snapshot: LeaderboardSnapshot = { "24h": [], "7d": [], "30d": [] };
  async replace(snapshot: LeaderboardSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }
  async update(window: LeaderboardWindowValue, userId: string, row: LeaderboardRow | null) {
    this.snapshot[window] = this.snapshot[window].filter((item) => item.userId !== userId);
    if (row) this.snapshot[window].push(structuredClone(row));
  }
  async top(window: LeaderboardWindowValue, limit: number) {
    return [...this.snapshot[window]]
      .sort((a, b) => b.pnlUsd - a.pnlUsd || b.userId.localeCompare(a.userId))
      .slice(0, limit);
  }
  async rank(window: LeaderboardWindowValue, userId: string) {
    const rows = await this.top(window, this.snapshot[window].length);
    const index = rows.findIndex((row) => row.userId === userId);
    return index === -1 ? null : index + 1;
  }
  async rankOrder(window: LeaderboardWindowValue) {
    return (await this.top(window, this.snapshot[window].length)).map(({ userId }) => userId);
  }
}
