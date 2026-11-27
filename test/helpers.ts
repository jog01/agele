import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { type Container, createContainer } from "../src/container";
import { getDb } from "../src/db/client";
import { seedSocialDemo } from "../src/db/seed-social";
import { comments, positions, theses, trades, users } from "../src/models";
import { InMemoryFollowRepository } from "../src/repositories/follow.repository";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TokenService } from "../src/services/token.service";

export const FIXED_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
export const SOL = "So11111111111111111111111111111111111111112";

export function socialDemoFixture() {
  const db = getDb();
  let ids: string[] = [];
  return {
    async setUp() {
      const condition = eq(users.demo, true);
      const before = await db.select({ id: users.id }).from(users).where(condition);
      await seedSocialDemo(db);
      const after = await db.select({ id: users.id }).from(users).where(condition);
      ids = after.filter(({ id }) => !before.some((user) => user.id === id)).map(({ id }) => id);
    },
    async tearDown() {
      await db.delete(comments).where(inArray(comments.userId, ids));
      await db.delete(theses).where(inArray(theses.userId, ids));
      await db.delete(trades).where(inArray(trades.userId, ids));
      await db.delete(positions).where(inArray(positions.userId, ids));
      await db.delete(users).where(inArray(users.id, ids));
    },
  };
}

export function testApp(overrides: Partial<Container> = {}) {
  const market = new MockMarketDataProvider(() => FIXED_NOW);
  const container = createContainer({
    events: { publish() {} },
    market,
    tokens: new TokenService(market),
    follows: new InMemoryFollowRepository(),
    ...overrides,
  });
  return createApp(container);
}
