import { afterAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client";
import { swaps } from "../src/models/swaps";
import { users } from "../src/models/users";
import { PgSwapRepository } from "../src/repositories/swap.repository";
import { REQUEST, WALLET } from "./swap-helpers";

afterAll(closeDb);

describe("PgSwapRepository", () => {
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
