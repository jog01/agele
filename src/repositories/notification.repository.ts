import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type NewNotification, notificationSettings, notifications } from "../models";
import type { AlertSettings, NotificationDetails, NotificationPage } from "../schemas/notification";
import type { FeedCursor } from "../services/social/cursor";

export const DEMO_INBOX_USER_ID = "ade10000-0000-4000-8000-000000000000";

export const DEFAULT_ALERT_SETTINGS = { traderActivity: true, sound: false } satisfies AlertSettings;

export type NotificationDelivery = (recipientId: string) => Promise<void>;

export async function insertNotifications(db: Pick<Db, "insert">, rows: NewNotification[]) {
  if (!rows.length) return [];
  return db
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing({ target: [notifications.recipientId, notifications.eventKey] })
    .returning({ recipientId: notifications.recipientId, id: notifications.id });
}

type Item = NotificationPage["items"][number];
type PageRow = Pick<Item, "id" | "createdAt" | "readAt" | "actors" | "actorCount"> & {
  cursorId: string;
  details: NotificationDetails;
  token: { mint: string; symbol: string; imageUrl: string | null } | null;
};

export const routableWallet = sql<string | null>`coalesce(u.wallet_address, (
  select w.address from wallets w where w.user_id = u.id and w.chain_type = 'solana'
  order by w.is_primary desc, w.address limit 1
))`;

const belongsTo = (userId: string, demo: boolean) => sql`recipient_id = ${userId} and (${demo} or not demo)`;

async function unreadCount(db: Pick<Db, "execute">, userId: string, demo: boolean) {
  const [row] = await db.execute<{ unreadCount: number }>(sql`
    select count(distinct coalesce(group_key, id::text))::int as "unreadCount"
    from notifications where ${belongsTo(userId, demo)} and read_at is null
  `);
  return row!;
}

export class PgNotificationRepository {
  constructor(private readonly db: Db) {}

  async list(recipientId: string, demo: boolean, limit: number, cursor?: FeedCursor) {
    return this.db.execute<PageRow>(sql`
      with events as (
        select *, coalesce(group_key, id::text) as item_key
        from notifications where ${belongsTo(recipientId, demo)}
      ), grouped as (
        select *, row_number() over w as newest, count(actor_id) over (partition by item_key)::int as actor_count,
          case when bool_and(read_at is not null) over (partition by item_key)
            then max(read_at) over (partition by item_key) end as group_read_at
        from events window w as (partition by item_key order by created_at desc, id desc)
      ), page as (
        select * from grouped where newest = 1
        ${cursor ? sql`and (created_at, id) < (${new Date(cursor.createdAt).toISOString()}::timestamptz, ${cursor.id}::uuid)` : sql.empty()}
        order by created_at desc, id desc limit ${limit}
      )
      select p.item_key as id, p.id as "cursorId", extract(epoch from p.created_at)::float8 as "createdAt",
        p.actor_count as "actorCount", p.details, a.actors,
        extract(epoch from p.group_read_at)::float8 as "readAt",
        case when t.mint is not null then jsonb_build_object('mint', t.mint, 'symbol', t.symbol,
          'imageUrl', t.image_url) end as token
      from page p
      left join tokens t on t.mint = p.mint
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('wallet', ${routableWallet}, 'handle', u.handle,
          'displayName', u.display_name, 'avatarUrl', u.avatar_url) order by g.newest), '[]'::jsonb) as actors
        from grouped g join users u on u.id = g.actor_id
        where g.item_key = p.item_key and g.newest <= 3
      ) a
      order by p.created_at desc, p.id desc
    `);
  }

  seedInbox(userId: string) {
    if (userId === DEMO_INBOX_USER_ID) return;
    return this.db.execute(sql`
      insert into notifications (recipient_id, actor_id, mint, event_key, group_key, demo, details, created_at, read_at)
      select ${userId}, actor_id, mint, event_key, group_key, true, details, created_at, read_at
      from notifications where recipient_id = ${DEMO_INBOX_USER_ID} and demo
      on conflict (recipient_id, event_key) do nothing
    `);
  }

  unreadCount(userId: string, demo: boolean) {
    return unreadCount(this.db, userId, demo);
  }

  markRead(userId: string, demo: boolean, itemId?: string) {
    return this.db.transaction(async (tx) => {
      const match = sql`${belongsTo(userId, demo)}
        ${itemId ? sql`and coalesce(group_key, id::text) = ${itemId}` : sql.empty()}`;
      const updated = await tx.execute(sql`
        update notifications set read_at = now() where ${match} and read_at is null
      `);
      const found =
        !itemId ||
        updated.count > 0 ||
        (
          await tx.execute(sql`
        select 1 from notifications where ${match} limit 1
      `)
        ).length > 0;
      return { result: found ? await unreadCount(tx, userId, demo) : undefined, changed: updated.count > 0 };
    });
  }

  async walletFor(userId: string) {
    const [row] = await this.db.execute<{ wallet: string | null }>(sql`
      select ${routableWallet} as wallet from users u where u.id = ${userId}
    `);
    return row?.wallet;
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
