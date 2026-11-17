import type { CommentDto, LeaderboardEntryDto, LeaderboardWindowValue } from "../../schemas/social";

/**
 * Read side of the social graph. Comments remain mock; indexed rankings use Redis.
 */
export interface SocialProvider {
  leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]>;
  comments(mint: string, limit: number): Promise<CommentDto[]>;
}
