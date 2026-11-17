import { describe, expect, it } from "bun:test";
import { PrivyClient } from "@privy-io/node";
import { env } from "../src/config/env";
import { createPrivyUserDirectory, PrivyApiUserDirectory } from "../src/services/privy-user-directory";

describe("Privy user directory", () => {
  it("fetches the DID and selects only Solana wallets, including nullable IDs", async () => {
    let path = "";
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        path = decodeURIComponent(new URL(request.url).pathname);
        return Response.json({
          linked_accounts: [
            { type: "email", address: "test@example.com" },
            { type: "wallet", chain_type: "ethereum", address: "eth", wallet_client_type: "privy" },
            { type: "wallet", chain_type: "solana", address: "external", wallet_client_type: "phantom" },
            {
              type: "wallet",
              chain_type: "solana",
              address: "embedded",
              wallet_client_type: "privy",
              id: "wallet-id",
            },
          ],
        });
      },
    });
    try {
      const directory = new PrivyApiUserDirectory(
        new PrivyClient({ appId: "app", appSecret: "test-secret", apiUrl: server.url.toString() }),
      );
      expect(await directory.getSolanaWallets("did:privy:test")).toEqual([
        { address: "external", chainType: "solana", walletClientType: "phantom", privyWalletId: null },
        { address: "embedded", chainType: "solana", walletClientType: "privy", privyWalletId: "wallet-id" },
      ]);
      expect(path).toBe("/v1/users/did:privy:test");
    } finally {
      server.stop(true);
    }
  });

  it("returns no wallets without a secret", async () => {
    const secret = env.PRIVY_APP_SECRET;
    let directory: ReturnType<typeof createPrivyUserDirectory>;
    try {
      env.PRIVY_APP_SECRET = undefined;
      directory = createPrivyUserDirectory();
    } finally {
      env.PRIVY_APP_SECRET = secret;
    }
    expect(await directory.getSolanaWallets("did:privy:test")).toEqual([]);
  });

  it("propagates Privy lookup errors", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "unavailable" }, { status: 403 }),
    });
    try {
      const directory = new PrivyApiUserDirectory(
        new PrivyClient({
          appId: "app",
          appSecret: "test-secret",
          apiUrl: server.url.toString(),
          maxRetries: 0,
        }),
      );
      await expect(directory.getSolanaWallets("did:privy:test")).rejects.toMatchObject({ status: 403 });
    } finally {
      server.stop(true);
    }
  });
});
