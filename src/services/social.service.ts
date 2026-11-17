import { badRequest, unauthorized } from "../lib/errors";
import type { FollowRepository } from "../repositories/follow.repository";
import type { UserWithWallets } from "../repositories/user.repository";
import type { LeaderboardWindowValue } from "../schemas/social";
import { decodeCursor } from "./social/cursor";
import type { SocialProvider } from "./social/provider";
import type { TokenService } from "./token.service";

export class SocialService {
  constructor(
    private readonly provider: SocialProvider,
    private readonly tokens: TokenService,
    private readonly follows: FollowRepository,
    private readonly ranks: Pick<SocialProvider, "leaderboard"> = provider,
    readonly leaderboardDemo = true,
  ) {}

  async leaderboard(window: LeaderboardWindowValue, limit: number, viewerId?: string) {
    const rows = await this.ranks.leaderboard(window, limit);
    if (!viewerId) return rows.map(({ isFollowing: _, ...row }) => row);
    const wallets = new Set(await this.follows.listWallets(viewerId));
    return rows.map((row) => ({ ...row, isFollowing: wallets.has(row.wallet) }));
  }

  async feed(input: { scope: "global" | "following"; cursor?: string; limit: number }, viewerId?: string) {
    if (input.scope === "following" && !viewerId) throw unauthorized("Missing bearer token");
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const wallets = input.scope === "following" ? await this.follows.listWallets(viewerId!) : undefined;
    return this.provider.feed({ wallets, cursor, limit: input.limit });
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

  async comments(mint: string, limit: number) {
    await this.tokens.getToken(mint);
    return this.provider.comments(mint, limit);
  }
}
