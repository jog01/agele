import { index, numeric, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
  ],
);

export type Trade = typeof trades.$inferSelect;
