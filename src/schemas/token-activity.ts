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
