import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const wallets = pgTable("wallets", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  address: text().notNull().unique(),
  chainType: text().$type<"solana">().notNull(),
  walletClientType: text().notNull(),
  privyWalletId: text(),
  isPrimary: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Wallet = typeof wallets.$inferSelect;
