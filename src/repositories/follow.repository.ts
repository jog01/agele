import { and, count, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { AppError } from "../lib/errors";
import { followActions, follows, trades, users } from "../models";
import { insertNotifications, type NotificationDelivery } from "./notification.repository";

const FOLLOW_CAP = 100;
const FOLLOW_RATE = 10;

export interface FollowRepository {
  listWallets(followerId: string): Promise<string[]>;
  follow(followerId: string, followeeWallet: string): Promise<void>;
  unfollow(followerId: string, followeeWallet: string): Promise<void>;
}

export class PgFollowRepository implements FollowRepository {
  constructor(
    private readonly db: Db,
    private readonly deliver?: NotificationDelivery,
  ) {}

  async listWallets(followerId: string) {
    const rows = await this.db
      .select({ wallet: follows.followeeWallet })
      .from(follows)
      .where(eq(follows.followerId, followerId));
    return rows.map(({ wallet }) => wallet);
  }

  async follow(followerId: string, followeeWallet: string) {
    const recipientId = await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, followerId)).for("no key update");
      const [added] = await tx
        .insert(follows)
        .values({ followerId, followeeWallet })
        .onConflictDoNothing()
        .returning({ wallet: follows.followeeWallet });
      if (!added) return;
      const [total] = await tx
        .select({ value: count() })
        .from(follows)
        .where(eq(follows.followerId, followerId));
      if (total!.value > FOLLOW_CAP) {
        const fills = await tx
          .select({ id: trades.id })
          .from(trades)
          .where(eq(trades.userId, followerId))
          .limit(3);
        if (fills.length < 3)
          throw new AppError(409, "follow_cap", "Trade at least three times to follow more wallets");
      }
      await tx
        .delete(followActions)
        .where(
          and(
            eq(followActions.userId, followerId),
            lt(followActions.createdAt, new Date(Date.now() - 60_000)),
          ),
        );
      const [recent] = await tx
        .select({ value: count() })
        .from(followActions)
        .where(eq(followActions.userId, followerId));
      if (recent!.value >= FOLLOW_RATE)
        throw new AppError(429, "follow_rate_limit", "Too many follows; try again shortly");
      await tx.insert(followActions).values({ userId: followerId });
      if (!this.deliver) return;
      const [recipient] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          or(
            eq(users.walletAddress, followeeWallet),
            sql`exists(
          select 1 from wallets w where w.user_id = ${users.id}
          and w.address = ${followeeWallet} and w.chain_type = 'solana'
        )`,
          ),
        )
        .orderBy(sql`(${users.walletAddress} = ${followeeWallet}) desc nulls last`)
        .limit(1);
      if (!recipient || recipient.id === followerId) return;
      const createdAt = new Date();
      const groupKey = `follow:${createdAt.toISOString().slice(0, 10)}`;
      const [notification] = await insertNotifications(tx, [
        {
          recipientId: recipient.id,
          actorId: followerId,
          createdAt,
          groupKey,
          eventKey: `${groupKey}:${followerId}`,
          details: { kind: "follow" },
        },
      ]);
      return notification?.recipientId;
    });
    if (recipientId) await this.deliver?.(recipientId);
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
