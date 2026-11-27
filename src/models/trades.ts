import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { users } from "./users";

export const tradeSide = pgEnum("trade_side", ["buy", "sell"]);

/** Every confirmed buy/sell made through the app, indexed from chain by signature. */
export const trades = pgTable(
  "trades",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    mint: text()
      .notNull()
      .references(() => tokens.mint),
    walletAddress: text(),
    side: tradeSide().notNull(),
    tokenAmount: numeric({ precision: 38, scale: 18 }).notNull(),
    quoteAmountUsd: numeric({ precision: 38, scale: 18 }).notNull(),
    solPriceUsd: numeric({ precision: 38, scale: 18 }),
    priceUsd: numeric({ precision: 38, scale: 18 }).notNull(),
    realizedPnlUsd: numeric({ precision: 38, scale: 18 }),
    signature: text().notNull(),
    executedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("trades_signature_user_id_unique").on(t.signature, t.userId),
    index("trades_user_executed_idx").on(t.userId, t.executedAt),
    index("trades_mint_executed_idx").on(t.mint, t.executedAt),
    index("trades_feed_idx").on(sql`date_trunc('second', ${t.executedAt} AT TIME ZONE 'UTC')`, t.id),
    index("trades_demo_seed_idx").on(t.id).where(sql`${t.signature} like 'demo:%'`),
  ],
);

export type Trade = typeof trades.$inferSelect;

export const pendingTradeFills = pgTable(
  "pending_trade_fills",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mint: text().notNull(),
    signature: text().notNull(),
    executedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.userId, t.signature),
    index("pending_trade_fills_position_idx").on(t.userId, t.mint, t.executedAt, t.id),
  ],
);
