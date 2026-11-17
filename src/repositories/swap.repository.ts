import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { type NewSwapRecord, type SwapRecord, swaps } from "../models/swaps";

export type SwapOutcome = Pick<
  SwapRecord,
  "status" | "signature" | "error" | "errorCode" | "inputAmountResult" | "outputAmountResult"
>;
export interface SwapListOptions {
  limit: number;
  cursor?: { createdAt: number; id: string };
}
export interface SwapRepository {
  create(record: NewSwapRecord): Promise<void>;
  find(userId: string, requestId: string): Promise<SwapRecord | undefined>;
  list(userId: string, options: SwapListOptions): Promise<SwapRecord[]>;
  claim(userId: string, requestId: string, now: Date): Promise<boolean>;
  finish(userId: string, requestId: string, outcome: SwapOutcome): Promise<void>;
}

export class PgSwapRepository implements SwapRepository {
  constructor(private readonly db: Db) {}

  async create(record: NewSwapRecord) {
    await this.db.insert(swaps).values(record);
  }

  async find(userId: string, requestId: string) {
    return this.db.query.swaps.findFirst({
      where: and(eq(swaps.userId, userId), eq(swaps.requestId, requestId)),
    });
  }

  async list(userId: string, { limit, cursor }: SwapListOptions) {
    const createdAt = sql`date_trunc('milliseconds', ${swaps.createdAt})`;
    return this.db
      .select()
      .from(swaps)
      .where(
        and(
          eq(swaps.userId, userId),
          cursor
            ? or(
                lt(createdAt, new Date(cursor.createdAt).toISOString()),
                and(eq(createdAt, new Date(cursor.createdAt).toISOString()), lt(swaps.requestId, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(createdAt), desc(swaps.requestId))
      .limit(limit);
  }

  async claim(userId: string, requestId: string, now: Date) {
    const rows = await this.db
      .update(swaps)
      .set({ status: "submitted", updatedAt: now })
      .where(
        and(
          eq(swaps.userId, userId),
          eq(swaps.requestId, requestId),
          eq(swaps.status, "issued"),
          gt(swaps.expiresAt, now),
        ),
      )
      .returning({ requestId: swaps.requestId });
    return rows.length === 1;
  }

  async finish(userId: string, requestId: string, outcome: SwapOutcome) {
    await this.db
      .update(swaps)
      .set({ ...outcome, updatedAt: new Date() })
      .where(and(eq(swaps.userId, userId), eq(swaps.requestId, requestId)));
  }
}
