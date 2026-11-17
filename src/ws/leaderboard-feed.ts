import { logger } from "../lib/logger";
import type { LeaderboardService } from "../services/leaderboard.service";

export function startLeaderboardFeed(leaderboard: Pick<LeaderboardService, "rebuild">) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await leaderboard.rebuild();
    } catch (err) {
      logger.warn({ err }, "Leaderboard rebuild failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 60000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
