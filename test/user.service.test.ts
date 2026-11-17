import { describe, expect, it } from "bun:test";
import type { UserRepository, UserWithWallets } from "../src/repositories/user.repository";
import type { LinkedWallet } from "../src/services/privy-user-directory";
import { UserService } from "../src/services/user.service";

const embedded: LinkedWallet = {
  address: "embedded",
  chainType: "solana",
  walletClientType: "privy",
  privyWalletId: "wallet-id",
};

function setup(linked: LinkedWallet[], fails = false) {
  let calls = 0;
  let user: UserWithWallets = {
    id: "user",
    privyDid: "did:privy:test",
    walletAddress: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    wallets: [],
  };
  const repo: UserRepository = {
    findByPrivyDid: async () => user,
    upsertByPrivyDid: async () => user,
    getWithWallets: async () => user,
    linkWallets: async (_, wallets) => {
      const primary = wallets.find((wallet) => wallet.walletClientType === "privy");
      user = {
        ...user,
        walletAddress: primary?.address ?? null,
        wallets: wallets.map((wallet, i) => ({
          ...wallet,
          id: String(i),
          userId: user.id,
          isPrimary: wallet === primary,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
      return user;
    },
  };
  const service = new UserService(repo, {
    getSolanaWallets: async () => {
      calls++;
      if (fails) throw new Error("Privy unavailable");
      return linked;
    },
  });
  return { service, calls: () => calls };
}

describe("UserService wallet linkage", () => {
  const claims = { privyDid: "did:privy:test", sessionId: "session" };

  it("links the first embedded Solana wallet, then uses persisted wallets", async () => {
    const { service, calls } = setup([
      { ...embedded, address: "external", walletClientType: "phantom", privyWalletId: null },
      embedded,
      { ...embedded, address: "second" },
    ]);
    const user = await service.ensureUser(claims);
    expect(user.walletAddress).toBe("embedded");
    expect(user.wallets.map((wallet) => wallet.isPrimary)).toEqual([false, true, false]);
    expect(await service.ensureUser(claims)).toEqual(user);
    expect(calls()).toBe(1);
  });

  it("keeps the primary address null with no wallets or external wallets only", async () => {
    for (const linked of [[], [{ ...embedded, walletClientType: "phantom" }]]) {
      const { service } = setup(linked);
      expect((await service.ensureUser(claims)).walletAddress).toBeNull();
    }
  });

  it("propagates directory failures rather than caching a missing wallet", async () => {
    const { service, calls } = setup([], true);
    await expect(service.ensureUser(claims)).rejects.toThrow("Privy unavailable");
    await expect(service.ensureUser(claims)).rejects.toThrow("Privy unavailable");
    expect(calls()).toBe(2);
  });
});
