import type { CommentDto, FeedPage, LeaderboardEntryDto, LeaderboardWindowValue } from "../../schemas/social";
import type { FeedCursor } from "./cursor";

/**
 * Read side of the social graph. Comments remain mock; indexed rankings use Redis.
 */
export interface SocialProvider {
  feed(input: { wallets?: string[]; cursor?: FeedCursor; limit: number }): Promise<FeedPage>;
  leaderboard(window: LeaderboardWindowValue, limit: number): Promise<LeaderboardEntryDto[]>;
  comments(mint: string, limit: number): Promise<CommentDto[]>;
}
