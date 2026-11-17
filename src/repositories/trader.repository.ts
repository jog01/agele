import { and, count, countDistinct, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { follows, users, wallets } from "../models";

export class PgTraderRepository {
  constructor(private readonly db: Db) {}

  async findByWallet(wallet: string) {
    const [linked] = await this.db
      .select({ user: users })
      .from(wallets)
      .innerJoin(users, eq(users.id, wallets.userId))
      .where(and(eq(wallets.address, wallet), eq(wallets.chainType, "solana")))
      .limit(1);
    if (linked) return linked.user;
    const [user] = await this.db.select().from(users).where(eq(users.walletAddress, wallet)).limit(1);
    return user;
  }

  async linkedAddresses(userId: string) {
    const rows = await this.db
      .select({ address: wallets.address })
      .from(wallets)
      .where(and(eq(wallets.userId, userId), eq(wallets.chainType, "solana")));
    return rows.map((row) => row.address);
  }

  async followerCount(addresses: string[]) {
    const [row] = await this.db
      .select({ value: countDistinct(follows.followerId) })
      .from(follows)
      .where(inArray(follows.followeeWallet, addresses));
    return row!.value;
  }

  async followingCount(userId: string) {
    const [row] = await this.db
      .select({ value: count() })
      .from(follows)
      .where(eq(follows.followerId, userId));
    return row!.value;
  }
}
