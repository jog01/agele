import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type NewNotification, notificationSettings, notifications } from "../models";
import type { AlertSettings, NotificationPage } from "../schemas/notification";
import type { FeedCursor } from "../services/social/cursor";

export const DEMO_INBOX_USER_ID = "ade10000-0000-4000-8000-000000000000";

export const DEFAULT_ALERT_SETTINGS = { traderActivity: true, sound: false } satisfies AlertSettings;

export type NotificationDelivery = (recipientId: string, sound?: boolean) => Promise<void>;

export async function insertNotifications(db: Pick<Db, "insert">, rows: NewNotification[]) {
  if (!rows.length) return [];
  return db
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing({ target: [notifications.recipientId, notifications.eventKey] })
    .returning({ recipientId: notifications.recipientId, id: notifications.id });
}

type PageRow = NotificationPage["items"][number] & { cursorId: string };

export class PgNotificationRepository {
  constructor(private readonly db: Db) {}

  async list(recipientId: string, demo: boolean, limit: number, cursor?: FeedCursor) {
    return this.db.execute<PageRow>(sql`
      with events as (
        select *, coalesce(group_key, id::text) as item_key
        from notifications where recipient_id = ${recipientId} and demo = ${demo}
      ), grouped as (
        select *, row_number() over w as newest, count(*) over (partition by item_key)::int as count
        from events window w as (partition by item_key order by created_at desc, id desc)
      ), page as (
        select * from grouped where newest = 1
        ${cursor ? sql`and (created_at, id) < (${new Date(cursor.createdAt).toISOString()}::timestamptz, ${cursor.id}::uuid)` : sql.empty()}
        order by created_at desc, id desc limit ${limit}
      )
      select p.item_key as id, p.id as "cursorId", extract(epoch from p.created_at)::float8 as "createdAt",
        p.count, p.details, a.actors,
        case when t.mint is not null then jsonb_build_object('mint', t.mint, 'symbol', t.symbol,
          'imageUrl', t.image_url) end as token
      from page p
      left join tokens t on t.mint = p.mint
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('wallet', u.wallet_address, 'handle', u.handle,
          'displayName', u.display_name, 'avatarUrl', u.avatar_url) order by g.newest), '[]'::jsonb) as actors
        from grouped g join users u on u.id = g.actor_id
        where g.item_key = p.item_key and g.newest <= 3
      ) a
      order by p.created_at desc, p.id desc
    `);
  }

  async settings(userId: string): Promise<AlertSettings> {
    const [row] = await this.db
      .select({ traderActivity: notificationSettings.traderActivity, sound: notificationSettings.sound })
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, userId));
    return row ?? DEFAULT_ALERT_SETTINGS;
  }

  async saveSettings(userId: string, settings: AlertSettings) {
    await this.db
      .insert(notificationSettings)
      .values({ userId, ...settings })
      .onConflictDoUpdate({ target: notificationSettings.userId, set: settings });
  }

  insert(row: NewNotification) {
    return insertNotifications(this.db, [row]);
  }
}
