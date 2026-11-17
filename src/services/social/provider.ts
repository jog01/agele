import type { CommentDto, FeedPage, LeaderboardEntryDto, LeaderboardWindowValue } from "../../schemas/social";
import type { FeedCursor } from "./cursor";

/**
 * Read side of the social graph. v0.1 ships a deterministic mock; the real implementation
 * reads Redis sorted sets (leaderboard:<window>) and the token_comments table.
 */
export interface SocialProvider {
  feed(input: { wallets?: string[]; cursor?: FeedCursor; limit: number }): Promise<FeedPage>;
  leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]>;
  comments(mint: string, limit: number): Promise<CommentDto[]>;
}
