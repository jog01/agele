import type { LeaderboardWindowValue } from "../schemas/social";
import type { SocialProvider } from "./social/provider";
import type { TokenService } from "./token.service";

export class SocialService {
  constructor(
    private readonly provider: SocialProvider,
    private readonly tokens: TokenService,
    private readonly ranks: Pick<SocialProvider, "leaderboard"> = provider,
    readonly leaderboardDemo = true,
  ) {}

  leaderboard(window: LeaderboardWindowValue, limit: number) {
    return this.ranks.leaderboard(window, limit);
  }

  async comments(mint: string, limit: number) {
    await this.tokens.getToken(mint);
    return this.provider.comments(mint, limit);
  }
}
