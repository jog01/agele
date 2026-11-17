import { PrivyClient } from "@privy-io/node";
import { env } from "../config/env";
import { logger } from "../lib/logger";

export interface LinkedWallet {
  address: string;
  chainType: "solana";
  walletClientType: string;
  privyWalletId: string | null;
}

export interface PrivyUserDirectory {
  getSolanaWallets(privyDid: string): Promise<LinkedWallet[]>;
}

export class PrivyApiUserDirectory implements PrivyUserDirectory {
  constructor(private readonly client: PrivyClient) {}

  async getSolanaWallets(privyDid: string): Promise<LinkedWallet[]> {
    const user = await this.client.users()._get(privyDid);
    return user.linked_accounts.flatMap((account) =>
      account.type === "wallet" && account.chain_type === "solana"
        ? [
            {
              address: account.address,
              chainType: "solana" as const,
              walletClientType: account.wallet_client_type ?? "unknown",
              privyWalletId: "id" in account ? (account.id ?? null) : null,
            },
          ]
        : [],
    );
  }
}

let loggedDisabled = false;

export function createPrivyUserDirectory(): PrivyUserDirectory {
  if (env.PRIVY_APP_ID && env.PRIVY_APP_SECRET) {
    return new PrivyApiUserDirectory(
      new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET }),
    );
  }
  if (!loggedDisabled) {
    logger.warn("Privy wallet linkage disabled: PRIVY_APP_ID or PRIVY_APP_SECRET is not set");
    loggedDisabled = true;
  }
  return { getSolanaWallets: async () => [] };
}
