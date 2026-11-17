import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { follows } from "../models";

export interface FollowRepository {
  listWallets(followerId: string): Promise<string[]>;
  follow(followerId: string, followeeWallet: string): Promise<void>;
  unfollow(followerId: string, followeeWallet: string): Promise<void>;
}

export class PgFollowRepository implements FollowRepository {
  constructor(private readonly db: Db) {}

  async listWallets(followerId: string) {
    const rows = await this.db
      .select({ wallet: follows.followeeWallet })
      .from(follows)
      .where(eq(follows.followerId, followerId));
    return rows.map(({ wallet }) => wallet);
  }

  async follow(followerId: string, followeeWallet: string) {
    await this.db.insert(follows).values({ followerId, followeeWallet }).onConflictDoNothing();
  }

  async unfollow(followerId: string, followeeWallet: string) {
    await this.db
      .delete(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followeeWallet, followeeWallet)));
  }
}

export class InMemoryFollowRepository implements FollowRepository {
  private readonly rows = new Map<string, Set<string>>();

  async listWallets(followerId: string) {
    return [...(this.rows.get(followerId) ?? [])];
  }

  async follow(followerId: string, followeeWallet: string) {
    const wallets = this.rows.get(followerId) ?? new Set<string>();
    wallets.add(followeeWallet);
    this.rows.set(followerId, wallets);
  }

  async unfollow(followerId: string, followeeWallet: string) {
    this.rows.get(followerId)?.delete(followeeWallet);
  }
}
