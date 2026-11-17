import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type NewUser, type User, users, type Wallet, wallets } from "../models";
import type { LinkedWallet } from "../services/privy-user-directory";

export type UserWithWallets = User & { wallets: Wallet[] };

export interface UserRepository {
  findByPrivyDid(privyDid: string): Promise<User | undefined>;
  upsertByPrivyDid(input: NewUser): Promise<User>;
  getWithWallets(userId: string): Promise<UserWithWallets>;
  linkWallets(userId: string, linked: LinkedWallet[]): Promise<UserWithWallets>;
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async getWithWallets(userId: string): Promise<UserWithWallets> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new Error("User not found");
    return { ...user, wallets: await this.db.select().from(wallets).where(eq(wallets.userId, userId)) };
  }

  async linkWallets(userId: string, linked: LinkedWallet[]): Promise<UserWithWallets> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user) throw new Error("User not found");
      if (!user.walletAddress) {
        const primary = linked.find((wallet) => wallet.walletClientType === "privy");
        for (const wallet of new Map(linked.map((wallet) => [wallet.address, wallet])).values()) {
          const [stored] = await tx
            .insert(wallets)
            .values({ ...wallet, userId, isPrimary: wallet.address === primary?.address })
            .onConflictDoUpdate({
              target: wallets.address,
              set: { ...wallet, isPrimary: wallet.address === primary?.address, updatedAt: new Date() },
              setWhere: eq(wallets.userId, userId),
            })
            .returning();
          if (!stored) throw new Error("Wallet already belongs to another user");
        }
        if (primary) {
          await tx
            .update(wallets)
            .set({ isPrimary: false })
            .where(and(eq(wallets.userId, userId), eq(wallets.isPrimary, true)));
          await tx.update(wallets).set({ isPrimary: true }).where(eq(wallets.address, primary.address));
          const [updated] = await tx
            .update(users)
            .set({ walletAddress: primary.address })
            .where(eq(users.id, userId))
            .returning();
          Object.assign(user, updated);
        }
      }
      return { ...user, wallets: await tx.select().from(wallets).where(eq(wallets.userId, userId)) };
    });
  }

  async findByPrivyDid(privyDid: string) {
    return this.db.query.users.findFirst({ where: eq(users.privyDid, privyDid) });
  }

  async upsertByPrivyDid(input: NewUser) {
    const [row] = await this.db
      .insert(users)
      .values(input)
      .onConflictDoUpdate({ target: users.privyDid, set: { updatedAt: new Date() } })
      .returning();
    if (!row) throw new Error("upsert returned no row");
    return row;
  }
}
