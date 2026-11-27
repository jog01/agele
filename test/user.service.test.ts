import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "../src/lib/logger";
import type { UserRepository, UserWithWallets } from "../src/repositories/user.repository";
import type { LinkedWallet } from "../src/services/privy-user-directory";
import { UserService } from "../src/services/user.service";

const embedded: LinkedWallet = {
  address: "embedded",
  chainType: "solana",
  walletClientType: "privy",
  privyWalletId: "wallet-id",
};

function setup(linked: LinkedWallet[], fails = false, storedWallets: UserWithWallets["wallets"] = []) {
  let calls = 0;
  let user: UserWithWallets = {
    id: "user",
    privyDid: "did:privy:test",
    walletAddress: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    bio: null,
    demo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    wallets: storedWallets,
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

  it("warns and returns stored wallets on directory failure, retrying on the next request", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const wallets of [
        [],
        [
          {
            ...embedded,
            walletClientType: "phantom",
            privyWalletId: null,
            id: "stored",
            userId: "user",
            isPrimary: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ]) {
        const { service, calls } = setup([], true, wallets);
        expect(await service.ensureUser(claims)).toMatchObject({ walletAddress: null, wallets });
        expect(await service.ensureUser(claims)).toMatchObject({ walletAddress: null, wallets });
        expect(calls()).toBe(2);
      }
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(
        { userId: "user" },
        "Privy wallet lookup failed; using stored wallets",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
