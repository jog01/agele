import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { users } from "./users";

export const follows = pgTable(
  "follows",
  {
    followerId: uuid()
      .notNull()
      .references(() => users.id),
    followeeId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index("follows_followee_idx").on(t.followeeId),
  ],
);

/** A user's thesis/comment on a token. */
export const comments = pgTable(
  "comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    mint: text()
      .notNull()
      .references(() => tokens.mint),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_mint_created_idx").on(t.mint, t.createdAt)],
);
