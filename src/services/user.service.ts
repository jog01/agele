import { logger } from "../lib/logger";
import type { UserRepository } from "../repositories/user.repository";
import type { AuthClaims } from "./auth.service";
import type { LinkedWallet, PrivyUserDirectory } from "./privy-user-directory";

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly directory: PrivyUserDirectory,
  ) {}

  /** First authenticated request creates the user row. */
  async ensureUser(claims: AuthClaims) {
    const user = await this.users.upsertByPrivyDid({ privyDid: claims.privyDid });
    if (user.walletAddress) return this.users.getWithWallets(user.id);
    let linked: LinkedWallet[];
    try {
      linked = await this.directory.getSolanaWallets(claims.privyDid);
    } catch {
      logger.warn({ userId: user.id }, "Privy wallet lookup failed; using stored wallets");
      return this.users.getWithWallets(user.id);
    }
    return this.users.linkWallets(user.id, linked);
  }
}
