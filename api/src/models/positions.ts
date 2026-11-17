import { numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { users } from "./users";

/** Running average-cost position per user and token, updated on every trade. */
export const positions = pgTable(
  "positions",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id),
    mint: text()
      .notNull()
      .references(() => tokens.mint),
    quantity: numeric({ precision: 38, scale: 18 }).notNull().default("0"),
    costBasisUsd: numeric({ precision: 38, scale: 18 }).notNull().default("0"),
    realizedPnlUsd: numeric({ precision: 38, scale: 18 }).notNull().default("0"),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.userId, t.mint] })],
);

export type Position = typeof positions.$inferSelect;
