import { sql } from "drizzle-orm";
import type { Db } from "./client";

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
