import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { decimal, divide, formatDecimal } from "../lib/decimal";
import { AppError } from "../lib/errors";
import {
  follows,
  notificationSettings,
  pendingTradeFills,
  positions,
  type Trade,
  tokens,
  trades,
  users,
  wallets,
} from "../models";
import type { ParsedTrade } from "../services/helius-parser";
import {
  DEFAULT_ALERT_SETTINGS,
  insertNotifications,
  type NotificationDelivery,
} from "./notification.repository";

export interface IndexedTrade extends ParsedTrade {
  userId: string;
  usd: bigint;
  solPriceUsd?: bigint;
  marketCapUsd?: number;
  symbol: string;
  name: string;
  imageUrl: string | null;
}

export interface TradeRepository {
  linkedWallets(addresses: string[]): Promise<{ address: string; userId: string }[]>;
  reserve(
    trade: Pick<IndexedTrade, "userId" | "mint" | "signature" | "timestamp">,
  ): Promise<"ready" | "indexed" | "pending">;
  record(trade: IndexedTrade): Promise<Trade | null>;
}

export class PgTradeRepository implements TradeRepository {
  constructor(
    private readonly db: Db,
    private readonly deliver?: NotificationDelivery,
  ) {}

  async linkedWallets(addresses: string[]) {
    if (!addresses.length) return [];
    return this.db
      .select({ address: wallets.address, userId: wallets.userId })
      .from(wallets)
      .where(and(inArray(wallets.address, addresses), eq(wallets.chainType, "solana")));
  }

  reserve({
    userId,
    mint,
    signature,
    timestamp,
  }: Pick<IndexedTrade, "userId" | "mint" | "signature" | "timestamp">) {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      const [indexed] = await tx
        .select({ id: trades.id })
        .from(trades)
        .where(and(eq(trades.userId, userId), eq(trades.signature, signature)));
      if (indexed) return "indexed";
      await tx
        .insert(pendingTradeFills)
        .values({ userId, mint, signature, executedAt: new Date(timestamp * 1000) })
        .onConflictDoNothing();
      const [first] = await tx
        .select({ signature: pendingTradeFills.signature })
        .from(pendingTradeFills)
        .where(and(eq(pendingTradeFills.userId, userId), eq(pendingTradeFills.mint, mint)))
        .orderBy(asc(pendingTradeFills.executedAt), asc(pendingTradeFills.id))
        .limit(1);
      return first?.signature === signature ? "ready" : "pending";
    });
  }

  async record(trade: IndexedTrade): Promise<Trade | null> {
    const result = await this.db.transaction(async (tx) => {
      // Serialize a user's position updates, including the first insert.
      const [trader] = await tx
        .select({ wallet: users.walletAddress })
        .from(users)
        .where(eq(users.id, trade.userId))
        .for("no key update");
      const [pending] = await tx
        .select({ signature: pendingTradeFills.signature })
        .from(pendingTradeFills)
        .where(and(eq(pendingTradeFills.userId, trade.userId), eq(pendingTradeFills.mint, trade.mint)))
        .orderBy(asc(pendingTradeFills.executedAt), asc(pendingTradeFills.id))
        .limit(1);
      if (pending && pending.signature !== trade.signature) {
        throw new AppError(503, "position_fill_pending", "An earlier position fill is pending");
      }
      await tx
        .insert(tokens)
        .values({
          mint: trade.mint,
          symbol: trade.symbol,
          name: trade.name,
          decimals: trade.decimals,
          imageUrl: trade.imageUrl,
        })
        .onConflictDoNothing();
      const [inserted] = await tx
        .insert(trades)
        .values({
          userId: trade.userId,
          mint: trade.mint,
          walletAddress: trade.wallet,
          side: trade.side,
          tokenAmount: formatDecimal(trade.amount),
          quoteAmountUsd: formatDecimal(trade.usd),
          solPriceUsd: trade.solPriceUsd === undefined ? null : formatDecimal(trade.solPriceUsd),
          priceUsd: formatDecimal(divide(trade.usd, trade.amount)),
          marketCapUsd: trade.marketCapUsd?.toFixed(2),
          signature: trade.signature,
          executedAt: new Date(trade.timestamp * 1000),
        })
        .onConflictDoNothing({ target: [trades.signature, trades.userId] })
        .returning();
      if (!inserted) return null;
      const predicate = and(eq(positions.userId, trade.userId), eq(positions.mint, trade.mint));
      const [position] = await tx.select().from(positions).where(predicate);
      let quantity = decimal(position?.quantity ?? "0");
      let cost = decimal(position?.costBasisUsd ?? "0");
      let realized = 0n;
      if (trade.side === "buy") {
        quantity += trade.amount;
        cost += trade.usd;
      } else {
        let sold = trade.amount;
        if (sold > quantity) sold = quantity;
        const basis = quantity ? (cost * sold) / quantity : 0n;
        realized = (trade.usd * sold) / trade.amount - basis;
        quantity -= sold;
        cost -= basis;
      }
      const values = {
        quantity: formatDecimal(quantity),
        costBasisUsd: formatDecimal(cost),
        realizedPnlUsd: formatDecimal(decimal(position?.realizedPnlUsd ?? "0") + realized),
        updatedAt: new Date(),
      };
      await tx
        .insert(positions)
        .values({ userId: trade.userId, mint: trade.mint, ...values })
        .onConflictDoUpdate({ target: [positions.userId, positions.mint], set: values });
      const [updated] = await tx
        .update(trades)
        .set({ realizedPnlUsd: formatDecimal(realized) })
        .where(eq(trades.id, inserted.id))
        .returning();
      await tx
        .delete(pendingTradeFills)
        .where(
          and(eq(pendingTradeFills.userId, trade.userId), eq(pendingTradeFills.signature, trade.signature)),
        );
      if (!this.deliver) return { trade: updated!, recipients: [] };
      const subscribers = await tx
        .selectDistinct({
          recipientId: follows.followerId,
          sound: sql<boolean>`coalesce(${notificationSettings.sound}, ${DEFAULT_ALERT_SETTINGS.sound})`,
        })
        .from(follows)
        .leftJoin(notificationSettings, eq(notificationSettings.userId, follows.followerId))
        .where(
          and(
            or(
              eq(follows.followeeWallet, trade.wallet),
              trader?.wallet ? eq(follows.followeeWallet, trader.wallet) : undefined,
            ),
            ne(follows.followerId, trade.userId),
            sql`coalesce(${notificationSettings.traderActivity}, ${DEFAULT_ALERT_SETTINGS.traderActivity})`,
          ),
        );
      const rows = await insertNotifications(
        tx,
        subscribers.map(({ recipientId }) => ({
          recipientId,
          actorId: trade.userId,
          mint: trade.mint,
          eventKey: `trader-activity:${inserted.id}`,
          createdAt: inserted.executedAt,
          details: {
            kind: "trader_activity",
            tradeId: inserted.id,
            signature: trade.signature,
            side: trade.side,
          },
        })),
      );
      const sounds = new Map(subscribers.map(({ recipientId, sound }) => [recipientId, sound]));
      return {
        trade: updated!,
        recipients: rows.map(({ recipientId }) => ({ recipientId, sound: sounds.get(recipientId) })),
      };
    });
    if (!result) return null;
    await Promise.all(result.recipients.map(({ recipientId, sound }) => this.deliver?.(recipientId, sound)));
    return result.trade;
  }
}
