import { sql } from "drizzle-orm";
import { env } from "../config/env";
import { type Db, getDb } from "./client";

export async function guardLiveStartup() {
  if (env.CHAIN_SOURCE === "solana" || env.MARKET_DATA_PROVIDER === "live") {
    await assertLiveDatabase(getDb());
  }
}

export async function assertLiveDatabase(db: Db) {
  const [state] = await db.execute<{ seeded: boolean }>(sql`
    select exists (select 1 from users where demo)
      or exists (select 1 from trades where signature like 'demo:%') as seeded
  `);
  if (state?.seeded) {
    throw new Error(
      "Live mode cannot start on a database with seeded demo data. Use a separate unseeded database.",
    );
  }
}
