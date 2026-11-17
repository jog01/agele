import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import * as schema from "../models";

let sql: postgres.Sql | undefined;
let database: ReturnType<typeof drizzle<typeof schema>> | undefined;

/** Lazily connected so routes that don't touch Postgres work without it. */
export function getDb() {
  if (!database) {
    sql = postgres(env.DATABASE_URL, { max: 10 });
    database = drizzle(sql, { schema, casing: "snake_case" });
  }
  return database;
}

export type Db = ReturnType<typeof getDb>;

export async function closeDb() {
  await sql?.end();
  sql = undefined;
  database = undefined;
}
