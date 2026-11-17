import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { type NewUser, type User, users } from "../models";

export interface UserRepository {
  findByPrivyDid(privyDid: string): Promise<User | undefined>;
  upsertByPrivyDid(input: NewUser): Promise<User>;
}

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findByPrivyDid(privyDid: string) {
    return this.db.query.users.findFirst({ where: eq(users.privyDid, privyDid) });
  }

  async upsertByPrivyDid(input: NewUser) {
    const [row] = await this.db
      .insert(users)
      .values(input)
      .onConflictDoUpdate({ target: users.privyDid, set: { updatedAt: new Date() } })
      .returning();
    if (!row) throw new Error("upsert returned no row");
    return row;
  }
}
