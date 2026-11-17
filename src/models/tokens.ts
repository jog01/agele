import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Token metadata cache; market data itself comes from the provider. */
export const tokens = pgTable("tokens", {
  mint: text().primaryKey(),
  symbol: text().notNull(),
  name: text().notNull(),
  decimals: integer().notNull(),
  imageUrl: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type Token = typeof tokens.$inferSelect;
