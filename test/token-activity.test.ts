import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../src/config/env";
import { decimal } from "../src/lib/decimal";
import { unauthorized } from "../src/lib/errors";
import * as schema from "../src/models";
import { PgTokenActivityRepository } from "../src/repositories/token-activity.repository";
import { PgTradeRepository } from "../src/repositories/trade.repository";
import { TokenPositionResponse, TokenTradersResponse } from "../src/schemas/token-activity";
import { USDC_MINT } from "../src/services/helius-parser";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TokenActivityService } from "../src/services/token-activity.service";
import type { UserService } from "../src/services/user.service";
import { FIXED_NOW, SOL, testApp } from "./helpers";

describe("indexed token positions and traders", () => {
  const sql = postgres(env.DATABASE_URL, { max: 3 });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  const repository = new PgTokenActivityRepository(db);
  const writer = new PgTradeRepository(db);
  const mint = crypto.randomUUID().replaceAll("-", "");
  const emptyMint = crypto.randomUUID().replaceAll("-", "");
  const providerOnlyMint = crypto.randomUUID().replaceAll("-", "");
  const storedOnlyMint = crypto.randomUUID().replaceAll("-", "");
  const unknownMint = crypto.randomUUID().replaceAll("-", "");
  const userIds: string[] = [];
  const addresses = ["alice", "bob", "charlie", "position-only"].map((name) => `${name}-${mint}`);
  let viewerId: string;
  let price: number | null = 15;
  let failPrice = false;
  const market = new MockMarketDataProvider();
  const originalGetToken = market.getToken.bind(market);
  market.getToken = async (requested) => {
    if (failPrice) throw new Error("Market unavailable");
    if (requested !== mint && requested !== providerOnlyMint) return null;
    if (price === null) return null;
    return { ...(await originalGetToken(SOL))!, mint: requested, symbol: "TEST", priceUsd: price };
  };
  const tokenActivity = new TokenActivityService(repository, market);
  const app = testApp({
    market,
    tokenActivity,
    auth: {
      verify: async (token) => {
        if (token !== "good") throw unauthorized("Invalid bearer token");
        return { privyDid: "did:privy:token-activity", sessionId: "session" };
      },
    },
    users: { ensureUser: async () => ({ id: viewerId }) } as unknown as UserService,
  });
  const getPosition = (requestedMint = mint) =>
    app.request(`/v1/tokens/${requestedMint}/positions`, {
      headers: { authorization: "Bearer good" },
    });
  const getTraders = (query = "", requestedMint = mint) =>
    app.request(`/v1/tokens/${requestedMint}/traders${query}`);

  beforeAll(async () => {
    for (const [index, address] of addresses.entries()) {
      const [user] = await db
        .insert(schema.users)
        .values({
          privyDid: `did:privy:${address}`,
          walletAddress: index === 1 ? null : address,
          handle: index === 0 ? `Alice-${mint}` : null,
        })
        .returning();
      userIds.push(user!.id);
    }
    viewerId = userIds[0]!;
    const record = (index: number, side: "buy" | "sell", amount: string, usd: string, tokenMint = mint) =>
      writer.record({
        userId: userIds[index]!,
        wallet: addresses[index]!,
        mint: tokenMint,
        signature: crypto.randomUUID(),
        timestamp: FIXED_NOW / 1000,
        decimals: 6,
        side,
        amount: decimal(amount),
        usd: decimal(usd),
        quoteMint: USDC_MINT,
        quoteAmount: decimal(usd),
        symbol: "TEST",
        name: "Test",
        imageUrl: null,
      });
    await record(0, "buy", "10", "100");
    await record(0, "sell", "4", "60");
    await record(1, "buy", "4", "40");
    await record(1, "sell", "4", "120");
    await record(2, "buy", "2", "20");
    await record(0, "buy", "1", "1000", emptyMint);
    await db
      .insert(schema.positions)
      .values({ userId: userIds[3]!, mint, quantity: "1", costBasisUsd: "100", realizedPnlUsd: "5" });
    await db
      .insert(schema.tokens)
      .values({ mint: storedOnlyMint, symbol: "STORED", name: "Stored", decimals: 6 });
  });
  afterAll(async () => {
    if (userIds.length) {
      await db.delete(schema.trades).where(inArray(schema.trades.userId, userIds));
      await db.delete(schema.positions).where(inArray(schema.positions.userId, userIds));
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.delete(schema.tokens).where(inArray(schema.tokens.mint, [mint, emptyMint, storedOnlyMint]));
    await sql.end();
  });

  it("returns only the authenticated viewer's open position using portfolio fields", async () => {
    const response = await getPosition();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Source")).toBe("indexed");
    expect(TokenPositionResponse.parse(await response.json())).toEqual({
      position: {
        mint,
        symbol: "TEST",
        quantity: 6,
        avgCostUsd: 10,
        priceUsd: 15,
        valueUsd: 90,
        unrealizedPnlUsd: 30,
        realizedPnlUsd: 20,
      },
    });
    viewerId = userIds[1]!;
    try {
      const closed = await getPosition();
      expect(TokenPositionResponse.parse(await closed.json())).toEqual({
        position: {
          mint,
          symbol: "TEST",
          quantity: 0,
          avgCostUsd: 0,
          priceUsd: 15,
          valueUsd: 0,
          unrealizedPnlUsd: 0,
          realizedPnlUsd: 80,
        },
      });
    } finally {
      viewerId = userIds[0]!;
    }
  });

  it("returns null for no viewer position and empty pages for known tokens without trades", async () => {
    viewerId = crypto.randomUUID();
    try {
      expect(await (await getPosition()).json()).toEqual({ position: null });
    } finally {
      viewerId = userIds[0]!;
    }
    const response = await getTraders("", providerOnlyMint);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Source")).toBe("indexed");
    expect(TokenTradersResponse.parse(await response.json())).toEqual({ traders: [], nextCursor: null });
    expect((await getTraders("", storedOnlyMint)).status).toBe(200);
    expect(await (await getTraders("", storedOnlyMint)).json()).toEqual({ traders: [], nextCursor: null });
    expect(await (await getPosition(storedOnlyMint)).json()).toEqual({ position: null });
  });

  it("ranks lifetime token volume, counts buys/sells and combines realized and unrealized PnL", async () => {
    const response = await getTraders();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Source")).toBe("indexed");
    const result = TokenTradersResponse.parse(await response.json());
    const top = userIds
      .slice(0, 2)
      .sort()
      .map((id) =>
        id === userIds[0]
          ? {
              wallet: addresses[0]!,
              handle: `Alice-${mint}`,
              buys: 1,
              sells: 1,
              volumeUsd: 160,
              realizedPnlUsd: 20,
              unrealizedPnlUsd: 30,
              pnlUsd: 50,
            }
          : {
              wallet: null,
              handle: id.slice(0, 8),
              buys: 1,
              sells: 1,
              volumeUsd: 160,
              realizedPnlUsd: 80,
              unrealizedPnlUsd: 0,
              pnlUsd: 80,
            },
      );
    expect(result).toEqual({
      traders: [
        ...top,
        {
          wallet: addresses[2]!,
          handle: addresses[2]!.slice(0, 8),
          buys: 1,
          sells: 0,
          volumeUsd: 20,
          realizedPnlUsd: 0,
          unrealizedPnlUsd: 10,
          pnlUsd: 10,
        },
      ],
      nextCursor: null,
    });
  });

  it("keyset-paginates tied numeric volumes without losing or duplicating traders", async () => {
    const all = TokenTradersResponse.parse(await (await getTraders()).json());
    const seen = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const result = TokenTradersResponse.parse(
        await (await getTraders(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json(),
      );
      seen.push(...result.traders);
      cursor = result.nextCursor;
      if (page < 2) expect(cursor).toBeString();
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(all.traders);
  });

  it.each([null, 0])("falls back to each position's cost when the price is %s", async (unavailable) => {
    price = unavailable;
    try {
      expect(await (await getPosition()).json()).toMatchObject({
        position: { symbol: "TEST", priceUsd: 10, valueUsd: 60, unrealizedPnlUsd: 0 },
      });
      const { traders } = TokenTradersResponse.parse(await (await getTraders()).json());
      expect(traders.find((row) => row.wallet === addresses[0])).toMatchObject({
        unrealizedPnlUsd: 0,
        pnlUsd: 20,
      });
      expect(traders.find((row) => row.wallet === addresses[2])).toMatchObject({
        unrealizedPnlUsd: 0,
        pnlUsd: 0,
      });
    } finally {
      price = 15;
    }
  });

  it("requires a valid bearer for positions, leaves traders public and rejects unknown mints", async () => {
    for (const authorization of [undefined, "Basic bad", "Bearer bad"]) {
      expect(
        (
          await app.request(`/v1/tokens/${mint}/positions`, {
            headers: authorization ? { authorization } : {},
          })
        ).status,
      ).toBe(401);
    }
    expect((await getPosition(unknownMint)).status).toBe(404);
    expect((await getTraders("", unknownMint)).status).toBe(404);
    expect((await getPosition("invalid")).status).toBe(400);
    expect((await getTraders("", "invalid")).status).toBe(400);
  });

  it("rejects invalid limits, malformed cursors and cursors from a different mint", async () => {
    const first = TokenTradersResponse.parse(await (await getTraders("?limit=1")).json());
    expect((await getTraders(`?cursor=${first.nextCursor}`, emptyMint)).status).toBe(400);
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?cursor=",
      "?cursor=garbage",
      "?cursor=not+base64",
      `?cursor=${Buffer.from(JSON.stringify({ mint, volumeUsd: "NaN", userId: userIds[0] })).toString("base64url")}`,
    ]) {
      expect((await getTraders(query)).status).toBe(400);
    }
  });

  it("does not invent indexed results on market errors", async () => {
    failPrice = true;
    try {
      expect((await getPosition()).status).toBe(500);
      expect((await getTraders()).status).toBe(500);
    } finally {
      failPrice = false;
    }
  });
});
