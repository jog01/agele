import { expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { assertLiveDatabase } from "../src/db/live-data-guard";
import { tokens, trades, users } from "../src/models";
import { SOL } from "./helpers";

it.each([
  [
    "Helius with live market data",
    {
      MARKET_DATA_PROVIDER: "live",
      HELIUS_WEBHOOK_SECRET: "test",
      YELLOWSTONE_GRPC_URL: "",
      YELLOWSTONE_GRPC_TOKEN: "",
    },
  ],
  [
    "Yellowstone with indexed market data",
    {
      MARKET_DATA_PROVIDER: "indexed",
      HELIUS_WEBHOOK_SECRET: "",
      YELLOWSTONE_GRPC_URL: "https://yellowstone.example.invalid",
      YELLOWSTONE_GRPC_TOKEN: "test",
    },
  ],
] as const)(
  "blocks API, worker and feed startup with demo data for %s but accepts indexed fills",
  async (_name, config) => {
    const db = getDb();
    const id = crypto.randomUUID();
    await db
      .insert(tokens)
      .values({ mint: SOL, name: "Solana", symbol: "SOL", decimals: 9 })
      .onConflictDoNothing();
    await db.insert(users).values({ id, privyDid: `privy:startup:${id}` });
    const message = "Live mode cannot start on a database with seeded demo data.";
    try {
      await db.insert(trades).values({
        userId: id,
        mint: SOL,
        side: "buy",
        tokenAmount: "1",
        quoteAmountUsd: "1",
        priceUsd: "1",
        signature: `indexed:${id}`,
        executedAt: new Date(),
      });
      await expect(assertLiveDatabase(db)).resolves.toBeUndefined();
      await db.update(users).set({ demo: true }).where(eq(users.id, id));
      await expect(assertLiveDatabase(db)).rejects.toThrow(message);
      await db.update(users).set({ demo: false }).where(eq(users.id, id));
      await db
        .update(trades)
        .set({ signature: `demo:${id}` })
        .where(eq(trades.userId, id));
      await expect(assertLiveDatabase(db)).rejects.toThrow(message);

      await Promise.all(
        ["api", "worker", "feed"].map(async (app) => {
          const child = Bun.spawn([process.execPath, `src/apps/${app}.ts`], {
            env: { ...process.env, ...config },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 3000,
          });
          const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            child.stdout.text(),
            child.stderr.text(),
          ]);
          expect(exit).toBe(1);
          expect(stderr).toContain(message);
          expect(stdout).not.toMatch(/api listening|worker started|feed started/);
        }),
      );
    } finally {
      await db.delete(trades).where(eq(trades.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  },
);
