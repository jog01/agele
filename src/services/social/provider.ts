import type { CommentDto, LeaderboardEntryDto, LeaderboardWindowValue } from "../../schemas/social";

/**
 * Read side of the social graph. v0.1 ships a deterministic mock; the real implementation
 * reads Redis sorted sets (leaderboard:<window>) and the token_comments table.
 */
export interface SocialProvider {
  leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]>;
  comments(mint: string, limit: number): Promise<CommentDto[]>;
}
