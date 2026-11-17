import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const swapStatus = pgEnum("swap_status", ["issued", "submitted", "confirmed", "failed", "expired"]);

export const swaps = pgTable(
  "swaps",
  {
    requestId: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    wallet: text().notNull(),
    inputMint: text().notNull(),
    outputMint: text().notNull(),
    inAmount: text().notNull(),
    quotedOutAmount: text().notNull(),
    inputAmountResult: text(),
    outputAmountResult: text(),
    status: swapStatus().notNull().default("issued"),
    signature: text().unique(),
    error: text(),
    errorCode: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("swaps_user_created_idx").on(t.userId, t.createdAt)],
);

export type SwapRecord = typeof swaps.$inferSelect;
export type NewSwapRecord = typeof swaps.$inferInsert;
