import { date, index, numeric, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/** Daily net portfolio value per user, written by the portfolio-snapshot job. */
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id),
    day: date().notNull(),
    valueUsd: numeric({ precision: 38, scale: 18 }).notNull(),
    positionsValueUsd: numeric({ precision: 38, scale: 18 }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const publicPortfolioHourly = pgTable(
  "public_portfolio_hourly",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hour: timestamp({ withTimezone: true }).notNull(),
    valueUsd: numeric({ precision: 38, scale: 18 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hour] }), index("public_portfolio_hourly_hour_idx").on(t.hour)],
);
