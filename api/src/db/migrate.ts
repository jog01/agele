import { migrate } from "drizzle-orm/postgres-js/migrator";
import { logger } from "../lib/logger";
import { closeDb, getDb } from "./client";

await migrate(getDb(), { migrationsFolder: "./sql/migrations" });
logger.info("migrations applied");
await closeDb();
