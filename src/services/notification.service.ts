import { z } from "zod";
import type { EventPublisher } from "../events/bus";
import { badRequest, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import type { PgNotificationRepository } from "../repositories/notification.repository";
import type { AlertSettings, NotificationPage } from "../schemas/notification";
import type { LeaderboardWindowValue } from "../schemas/social";
import { notificationTopic } from "../ws/topics";
import { encodeCursor, type FeedCursor } from "./social/cursor";

const cursorSchema = z.object({
  id: z.uuid(),
  createdAt: z
    .number()
    .int()
    .min(0)
    .max(Date.UTC(9999, 11, 31)),
});

function parseCursor(value: string): FeedCursor {
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    if (encodeCursor(cursor) === value) return cursor;
  } catch {}
  throw badRequest("Invalid notification cursor");
}

export class NotificationService {
  constructor(
    private readonly repository: PgNotificationRepository,
    private readonly events: EventPublisher,
  ) {}

  async list(
    userId: string,
    source: NotificationPage["source"],
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage> {
    if (source === "demo") await this.repository.seedInbox(userId);
    const rows = await this.repository.list(
      userId,
      source === "demo",
      limit + 1,
      cursor ? parseCursor(cursor) : undefined,
    );
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map(({ cursorId: _, details, token, ...row }) => {
        switch (details.kind) {
          case "follow":
            return { ...row, kind: details.kind, target: { wallet: row.actors[0]?.wallet ?? null } };
          case "leaderboard":
            return { ...row, ...details };
          case "trader_trade":
            return { ...row, kind: details.kind, target: { ...details.target, ...token! } };
          case "thesis_like":
            return { ...row, kind: details.kind, target: { ...details.target, ...token! } };
          case "thesis_comment":
            return { ...row, kind: details.kind, target: { ...details.target, ...token! } };
          default:
            throw new Error("Unknown notification kind");
        }
      }),
      nextCursor:
        last && rows.length > limit
          ? encodeCursor({ id: last.cursorId, createdAt: Math.round(last.createdAt * 1000) })
          : null,
      source,
    };
  }

  settings(userId: string) {
    return this.repository.settings(userId);
  }

  async saveSettings(userId: string, settings: AlertSettings) {
    await this.repository.saveSettings(userId, settings);
    await this.inboxChanged(userId);
    return settings;
  }

  async unreadCount(userId: string, demo: boolean) {
    if (demo) await this.repository.seedInbox(userId);
    return this.repository.unreadCount(userId, demo);
  }

  async markRead(userId: string, demo: boolean, itemId?: string) {
    if (demo) await this.repository.seedInbox(userId);
    const { result, changed } = await this.repository.markRead(userId, demo, itemId);
    if (!result) throw notFound("Notification");
    if (changed) await this.inboxChanged(userId);
    return result;
  }

  inboxChanged = async (userId: string) => {
    try {
      const wallet = await this.repository.walletFor(userId);
      if (wallet) await this.events.publish(notificationTopic(wallet), { type: "changed" });
    } catch (err) {
      logger.warn({ err }, "Notification realtime delivery failed");
    }
  };

  rankChanged = async (
    userId: string,
    window: LeaderboardWindowValue,
    rank: number,
    previousRank: number | null,
    eventId: string,
  ) => {
    const [notification] = await this.repository.insert({
      recipientId: userId,
      eventKey: `leaderboard:${window}:${eventId}`,
      details: { kind: "leaderboard", target: { window, rank, previousRank } },
    });
    if (notification) await this.inboxChanged(userId);
  };
}
