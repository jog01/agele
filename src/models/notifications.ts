import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { NotificationDetails } from "../schemas/notification";
import { tokens } from "./tokens";
import { users } from "./users";

export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    recipientId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    mint: text().references(() => tokens.mint, { onDelete: "set null" }),
    eventKey: text().notNull(),
    groupKey: text(),
    demo: boolean().notNull().default(false),
    details: jsonb().$type<NotificationDetails>().notNull(),
    readAt: timestamp({ withTimezone: true, precision: 3 }),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    unique("notifications_recipient_event_unique").on(t.recipientId, t.eventKey),
    index("notifications_recipient_time_idx").on(t.recipientId, t.createdAt, t.id),
    index("notifications_recipient_group_idx").on(t.recipientId, t.groupKey, t.createdAt),
  ],
);

export const notificationSettings = pgTable("notification_settings", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  traderActivity: boolean().notNull(),
  sound: boolean().notNull(),
});

export type NewNotification = typeof notifications.$inferInsert;
