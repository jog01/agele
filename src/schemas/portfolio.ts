import { z } from "@hono/zod-openapi";

export const PortfolioSchema = z
  .object({
    equityUsd: z.number(),
    usdcBalance: z.number(),
    unrealizedPnlUsd: z.number(),
    realizedPnlUsd: z.number(),
    positions: z.array(
      z.object({
        mint: z.string(),
        symbol: z.string(),
        quantity: z.number(),
        avgCostUsd: z.number(),
        priceUsd: z.number(),
        valueUsd: z.number(),
        unrealizedPnlUsd: z.number(),
        realizedPnlUsd: z.number(),
      }),
    ),
  })
  .openapi("Portfolio");
export const HistoryQuery = z.object({ range: z.enum(["7d", "30d", "all"]).default("7d") });
export const PortfolioHistorySchema = z
  .object({ points: z.array(z.object({ time: z.number().int(), valueUsd: z.number() })) })
  .openapi("PortfolioHistory");
export const UserTradeSchema = z
  .object({
    id: z.string(),
    signature: z.string(),
    mint: z.string(),
    symbol: z.string(),
    side: z.enum(["buy", "sell"]),
    tokenAmount: z.number(),
    priceUsd: z.number(),
    valueUsd: z.number(),
    realizedPnlUsd: z.number().nullable(),
    time: z.number().int(),
  })
  .openapi("UserTrade");
export const UserTradesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export const UserTradesSchema = z.object({
  trades: z.array(UserTradeSchema),
  nextCursor: z.string().nullable(),
});
