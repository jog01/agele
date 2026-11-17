import { describe, expect, it, spyOn } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../src/db/client";
import { logger } from "../src/lib/logger";
import { type User, users, type Wallet, wallets } from "../src/models";
import { PgUserRepository } from "../src/repositories/user.repository";
import type { LinkedWallet } from "../src/services/privy-user-directory";

function setup(conflicts: string[], insertError?: Error) {
  const user: User = {
    id: "user",
    privyDid: "did:privy:test",
    walletAddress: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const stored: Wallet[] = [];
  const updates: { table: unknown; values: Record<string, unknown>; where: SQL }[] = [];
  const guards: SQL[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () =>
          Object.assign(Promise.resolve(table === users ? [user] : stored), { for: async () => [user] }),
      }),
    }),
    insert: () => ({
      values: (input: LinkedWallet & { userId: string; isPrimary: boolean }) => ({
        onConflictDoUpdate: (options: { setWhere: SQL }) => {
          guards.push(options.setWhere);
          return {
            returning: async () => {
              if (insertError) throw insertError;
              if (conflicts.includes(input.address)) return [];
              const wallet = { ...input, id: input.address, createdAt: new Date(), updatedAt: new Date() };
              stored.push(wallet);
              return [wallet];
            },
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: SQL) => {
          updates.push({ table, values, where });
          if (table === users) Object.assign(user, values);
          return Object.assign(Promise.resolve(), { returning: async () => [user] });
        },
      }),
    }),
  };
  const db = {
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Db;
  return { repo: new PgUserRepository(db), updates, guards };
}

const wallet = (address: string, walletClientType = "privy"): LinkedWallet => ({
  address,
  walletClientType,
  chainType: "solana",
  privyWalletId: null,
});

describe("PgUserRepository wallet ownership conflicts", () => {
  it("skips conflicting wallets and chooses the first successfully stored embedded wallet", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { repo, updates, guards } = setup(["taken-external", "taken-embedded"]);
      const result = await repo.linkWallets("user", [
        wallet("taken-external", "phantom"),
        wallet("taken-embedded"),
        wallet("external", "phantom"),
        wallet("primary"),
        wallet("secondary"),
      ]);
      expect(result.walletAddress).toBe("primary");
      expect(result.wallets.map((item) => item.address)).toEqual(["external", "primary", "secondary"]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        { userId: "user", address: "taken-embedded" },
        "Skipping wallet owned by another user",
      );
      const dialect = new PgDialect({ casing: "snake_case" });
      expect(guards.map((guard) => dialect.sqlToQuery(guard))).toEqual(
        Array(5).fill({ sql: '"wallets"."user_id" = $1', params: ["user"], typings: ["uuid"] }),
      );
      const primaryUpdates = updates.filter(
        (update) => update.table === wallets && update.values.isPrimary === true,
      );
      expect(primaryUpdates).toHaveLength(1);
      expect(dialect.sqlToQuery(primaryUpdates[0]!.where).params).toEqual(["primary"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps walletAddress null without an eligible stored embedded wallet", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (const linked of [[], [wallet("taken")], [wallet("taken"), wallet("external", "phantom")]]) {
        const { repo, updates } = setup(["taken"]);
        const result = await repo.linkWallets("user", linked);
        expect(result.walletAddress).toBeNull();
        expect(result.wallets.every((item) => !item.isPrimary)).toBe(true);
        expect(updates).toEqual([]);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("does not suppress unrelated database failures", async () => {
    const { repo } = setup([], new Error("database unavailable"));
    await expect(repo.linkWallets("user", [wallet("new")])).rejects.toThrow("database unavailable");
  });
});
