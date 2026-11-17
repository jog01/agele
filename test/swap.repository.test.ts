import { afterAll, describe, expect, it } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client";
import { swaps } from "../src/models/swaps";
import { users } from "../src/models/users";
import { PgSwapRepository } from "../src/repositories/swap.repository";
import { REQUEST, WALLET } from "./swap-helpers";

afterAll(closeDb);

describe("PgSwapRepository", () => {
  it("lists only the owner, newest first with stable ties and exclusive cursor pagination", async () => {
    const db = getDb();
    const owner = crypto.randomUUID(),
      other = crypto.randomUUID();
    await db
      .insert(users)
      .values([owner, other].map((id) => ({ id, privyDid: `did:privy:swap-list:${id}` })));
    const repo = new PgSwapRepository(db);
    const prefix = crypto.randomUUID();
    const base = {
      userId: owner,
      wallet: WALLET,
      inputMint: REQUEST.inputMint,
      outputMint: REQUEST.outputMint,
      inAmount: REQUEST.amount,
      quotedOutAmount: "39787085",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
    };
    try {
      await db.insert(swaps).values([
        { ...base, requestId: `${prefix}-a`, createdAt: sql`'2026-01-01T12:00:00.000900Z'::timestamptz` },
        { ...base, requestId: `${prefix}-b`, createdAt: sql`'2026-01-01T12:00:00.000100Z'::timestamptz` },
        { ...base, requestId: `${prefix}-c`, createdAt: new Date("2026-01-01T13:00:00Z") },
        {
          ...base,
          userId: other,
          requestId: `${prefix}-private`,
          createdAt: new Date("2026-01-02T00:00:00Z"),
        },
      ]);
      const first = await repo.list(owner, { limit: 2 });
      expect(first.map((r) => r.requestId)).toEqual([`${prefix}-c`, `${prefix}-b`]);
      const cursor = { createdAt: first[1]!.createdAt.getTime(), id: first[1]!.requestId };
      const second = await repo.list(owner, { limit: 2, cursor });
      expect(second.map((r) => r.requestId)).toEqual([`${prefix}-a`]);
      expect(
        await repo.list(owner, {
          limit: 2,
          cursor: {
            createdAt: second[0]!.createdAt.getTime(),
            id: second[0]!.requestId,
          },
        }),
      ).toEqual([]);
      expect(await repo.list(crypto.randomUUID(), { limit: 25 })).toEqual([]);
      expect((await repo.list(other, { limit: 25 })).map((r) => r.requestId)).toEqual([`${prefix}-private`]);
      expect((await repo.list(other, { limit: 25, cursor })).every((r) => r.userId === other)).toBe(true);
    } finally {
      await db.delete(swaps).where(inArray(swaps.userId, [owner, other]));
      await db.delete(users).where(inArray(users.id, [owner, other]));
    }
  });
  it("persists outcomes, enforces ownership, expiry, request/signature uniqueness and concurrent claims", async () => {
    const db = getDb();
    const userId = crypto.randomUUID();
    await db.insert(users).values({ id: userId, privyDid: `did:privy:swap-test:${userId}` });
    const repo = new PgSwapRepository(db);
    const requestId = crypto.randomUUID();
    const record = {
      requestId,
      userId,
      wallet: WALLET,
      inputMint: REQUEST.inputMint,
      outputMint: REQUEST.outputMint,
      inAmount: REQUEST.amount,
      quotedOutAmount: "39787085",
      expiresAt: new Date(Date.now() + 30_000),
    };
    try {
      await repo.create(record);
      expect(await repo.find(crypto.randomUUID(), requestId)).toBeUndefined();
      expect(await repo.find(userId, requestId)).toMatchObject({
        ...record,
        status: "issued",
        signature: null,
      });
      await expect(repo.create(record)).rejects.toThrow();
      expect(
        (
          await Promise.all([
            repo.claim(userId, requestId, new Date()),
            repo.claim(userId, requestId, new Date()),
          ])
        ).sort(),
      ).toEqual([false, true]);
      const outcome = {
        status: "confirmed" as const,
        signature: `signature:${requestId}`,
        error: null,
        errorCode: "0",
        inputAmountResult: REQUEST.amount,
        outputAmountResult: "39787085",
      };
      await repo.finish(userId, requestId, outcome);
      await repo.finish(userId, requestId, outcome);
      expect(await repo.find(userId, requestId)).toMatchObject(outcome);
      const expired = crypto.randomUUID();
      await repo.create({ ...record, requestId: expired, expiresAt: new Date(Date.now() - 1) });
      expect(await repo.claim(userId, expired, new Date())).toBe(false);
      const another = crypto.randomUUID();
      await repo.create({ ...record, requestId: another });
      await expect(repo.finish(userId, another, outcome)).rejects.toThrow();
      expect((await repo.find(userId, another))!.signature).toBeNull();
    } finally {
      await db.delete(swaps).where(eq(swaps.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
