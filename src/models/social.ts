import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { trades } from "./trades";
import { users } from "./users";

export const follows = pgTable(
  "follows",
  {
    followerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeWallet: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeWallet] }),
    index("follows_followee_idx").on(t.followeeWallet),
  ],
);

export const postKind = pgEnum("social_post_kind", ["thesis", "comment"]);
export const postPosition = pgEnum("social_post_position", ["long", "short", "none"]);

export const theses = pgTable(
  "theses",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    wallet: text().notNull(),
    mint: text()
      .notNull()
      .references(() => tokens.mint),
    positionId: uuid()
      .notNull()
      .references(() => trades.id),
    viewCount: bigint({ mode: "number" }).notNull().default(0),
  },
  (t) => [unique().on(t.wallet, t.mint, t.positionId)],
);

export const feedDiscussions = pgTable("feed_discussions", {
  key: text().primaryKey(),
  mint: text()
    .notNull()
    .references(() => tokens.mint, { onDelete: "cascade" }),
});

export const thesisViewers = pgTable(
  "thesis_viewers",
  {
    thesisId: uuid()
      .notNull()
      .references(() => theses.id, { onDelete: "cascade" }),
    viewerKey: text().notNull(),
    countedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.thesisId, t.viewerKey] }),
    index("thesis_viewers_counted_at_idx").on(t.countedAt),
  ],
);

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
    kind: postKind().notNull().default("comment"),
    position: postPosition().notNull().default("none"),
    thesisId: uuid().references(() => theses.id, { onDelete: "cascade" }),
    discussionKey: text().references(() => feedDiscussions.key, { onDelete: "cascade" }),
    parentId: uuid().references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    pinned: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("comments_mint_created_idx").on(t.mint, t.createdAt),
    index("comments_thesis_idx").on(t.thesisId),
    index("comments_discussion_idx").on(t.discussionKey),
    index("comments_parent_idx").on(t.parentId),
    uniqueIndex("comments_pinned_thesis_idx").on(t.thesisId).where(sql`${t.pinned}`),
    index("comments_user_created_idx").on(t.userId, t.createdAt),
    index("comments_feed_idx")
      .on(sql`date_trunc('second', ${t.createdAt} AT TIME ZONE 'UTC')`, t.id)
      .where(sql`${t.kind} = 'thesis'`),
    check(
      "comments_thesis_shape",
      sql`${t.kind} <> 'thesis' OR (${t.parentId} IS NULL AND ${t.thesisId} IS NOT NULL)`,
    ),
    check("comments_pin_shape", sql`not ${t.pinned} OR ${t.kind} = 'thesis'`),
    check(
      "comments_discussion_shape",
      sql`${t.discussionKey} IS NULL OR (${t.thesisId} IS NULL AND ${t.kind} = 'comment')`,
    ),
  ],
);

export const followActions = pgTable(
  "social_follow_actions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("social_follow_actions_user_time_idx").on(t.userId, t.createdAt)],
);

export const reactions = pgTable(
  "social_reactions",
  {
    postId: uuid()
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] })],
);

export const feedReactions = pgTable(
  "feed_reactions",
  {
    discussionKey: text()
      .notNull()
      .references(() => feedDiscussions.key, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.discussionKey, t.userId] })],
);
