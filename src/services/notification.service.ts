import { z } from "zod";
import type { EventPublisher } from "../events/bus";
import { badRequest } from "../lib/errors";
import { logger } from "../lib/logger";
import type { PgNotificationRepository } from "../repositories/notification.repository";
import type { AlertSettings, NotificationPage, NotificationUpdateSchema } from "../schemas/notification";
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

  async list(userId: string, source: NotificationPage["source"], limit: number, cursor?: string) {
    const rows = await this.repository.list(
      userId,
      source === "demo",
      limit + 1,
      cursor ? parseCursor(cursor) : undefined,
    );
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map(({ cursorId: _, ...row }) => row),
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
    await this.publish(userId, { kind: "settings" });
    return settings;
  }

  inboxChanged = (userId: string, sound = false) => this.publish(userId, { kind: "inbox", sound });

  rankChanged = async (
    userId: string,
    window: LeaderboardWindowValue,
    rank: number,
    previousRank: number | null,
    tradeId: string,
  ) => {
    const [notification] = await this.repository.insert({
      recipientId: userId,
      eventKey: `leaderboard:${window}:${tradeId}`,
      details: { kind: "leaderboard", window, rank, previousRank },
    });
    if (notification) await this.inboxChanged(userId);
  };

  private async publish(userId: string, data: z.infer<typeof NotificationUpdateSchema>) {
    try {
      await this.events.publish(notificationTopic(userId), data);
    } catch (err) {
      logger.warn({ err }, "Notification realtime delivery failed");
    }
  }
}
