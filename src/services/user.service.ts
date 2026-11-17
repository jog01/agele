import type { UserRepository } from "../repositories/user.repository";
import type { AuthClaims } from "./auth.service";
import type { PrivyUserDirectory } from "./privy-user-directory";

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly directory: PrivyUserDirectory,
  ) {}

  /** First authenticated request creates the user row. */
  async ensureUser(claims: AuthClaims) {
    const user = await this.users.upsertByPrivyDid({ privyDid: claims.privyDid });
    if (user.walletAddress) return this.users.getWithWallets(user.id);
    const linked = await this.directory.getSolanaWallets(claims.privyDid);
    return this.users.linkWallets(user.id, linked);
  }
}
