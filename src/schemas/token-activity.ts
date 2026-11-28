import { z } from "@hono/zod-openapi";

export const TokenPositionSchema = z
  .object({
    mint: z.string(),
    symbol: z.string(),
    quantity: z.number(),
    avgCostUsd: z.number(),
    priceUsd: z.number(),
    valueUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    realizedPnlUsd: z.number(),
  })
  .openapi("TokenPosition");

export const TokenPositionResponse = z.object({ position: TokenPositionSchema.nullable() });

export const TokenTradersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(1024).optional(),
});

export const TokenTraderSchema = z
  .object({
    wallet: z.string().nullable().describe("Primary wallet, or null if the user has none"),
    handle: z.string(),
    buys: z.number().int(),
    sells: z.number().int(),
    volumeUsd: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    pnlUsd: z.number(),
  })
  .openapi("TokenTrader");

export const TokenTradersResponse = z.object({
  traders: z.array(TokenTraderSchema),
  nextCursor: z.string().nullable(),
});

const queryFlag = z.stringbool().default(false);

export const TokenHoldersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  scope: z
    .enum(["all", "traders"])
    .default("all")
    .describe("all: largest owner wallets; traders: Agele traders holding the token"),
  thesisOnly: queryFlag.describe("Only holders with a thesis on this token"),
  followingOnly: queryFlag.describe("Only holders the viewer follows; requires a bearer token"),
  minValueUsd: z.coerce.number().min(0).default(0).describe("Inclusive minimum holding value"),
});

export const HolderTraderSchema = z
  .object({
    wallet: z.string().nullable(),
    handle: z.string().nullable(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    avgHoldSeconds: z.number().int().nullable().describe("Average hold across closed positions"),
    source: z.enum(["demo", "indexed"]),
  })
  .openapi("HolderTrader");

export const HolderPositionSchema = z
  .object({
    positionId: z.string().describe("Opening fill ID of the open position, for replay"),
    firstBoughtAt: z.number().int().describe("Unix seconds"),
    investedUsd: z.number(),
    avgEntryMarketCapUsd: z.number().nullable(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    pnlUsd: z.number(),
    pnlPct: z.number(),
  })
  .openapi("HolderPosition");

export const HolderThesisSchema = z
  .object({
    thesisId: z.string(),
    postId: z.string().describe("Newest thesis version"),
    positionId: z.string(),
    body: z.string(),
    createdAt: z.number().int().describe("Unix seconds"),
    likeCount: z.number().int(),
    replyCount: z.number().int(),
    viewCount: z.number().int(),
  })
  .openapi("HolderThesis");

export const TokenHolderListSchema = z
  .object({
    mint: z.string(),
    scope: z.enum(["all", "traders"]),
    totalHolders: z.number().int(),
    top10Pct: z.number(),
    holders: z.array(
      z.object({
        rank: z.number().int().describe("Rank within the unfiltered list for this scope"),
        wallet: z.string(),
        amount: z.number(),
        pctSupply: z.number(),
        valueUsd: z.number(),
        isPool: z.boolean().optional(),
        label: z.string().optional(),
        trader: HolderTraderSchema.nullable(),
        isFollowed: z.boolean().describe("False for anonymous viewers"),
        position: HolderPositionSchema.nullable(),
        latestThesis: HolderThesisSchema.nullable(),
      }),
    ),
    updatedAt: z.number().int().openapi({ description: "Snapshot time, Unix seconds" }),
  })
  .openapi("TokenHolders");
