import { z } from "@hono/zod-openapi";

export const TokenSchema = z
  .object({
    mint: z.string(),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number().int(),
    imageUrl: z.string().nullable(),
    priceUsd: z.number(),
    priceChange24hPct: z.number(),
    marketCapUsd: z.number(),
    liquidityUsd: z.number(),
    volume24hUsd: z.number(),
    holders: z.number().int(),
  })
  .openapi("Token");

export const CandleSchema = z
  .object({
    time: z.number().int().openapi({ description: "Bucket start, unix seconds" }),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
  })
  .openapi("Candle");

export const TradeSchema = z
  .object({
    signature: z.string(),
    mint: z.string(),
    side: z.enum(["buy", "sell"]),
    trader: z.string(),
    tokenAmount: z.number(),
    amountUsd: z.number(),
    priceUsd: z.number(),
    time: z.number().int(),
  })
  .openapi("Trade");

export const Interval = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);

export const TokenHoldersSchema = z
  .object({
    mint: z.string(),
    totalHolders: z.number().int(),
    top10Pct: z.number(),
    holders: z.array(
      z.object({
        rank: z.number().int(),
        wallet: z.string(),
        amount: z.number(),
        pctSupply: z.number(),
        valueUsd: z.number(),
        isPool: z.boolean().optional(),
        label: z.string().optional(),
      }),
    ),
    updatedAt: z.number().int().openapi({ description: "Snapshot time, Unix seconds" }),
  })
  .openapi("TokenHolders");
export type TokenHoldersDto = z.infer<typeof TokenHoldersSchema>;

export const HoldersQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(20)
    .openapi({ param: { name: "limit", in: "query" } }),
});

export const CandlesQuery = z.object({
  interval: Interval.default("5m").openapi({ param: { name: "interval", in: "query" } }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(300)
    .openapi({ param: { name: "limit", in: "query" } }),
});

export const ListQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .openapi({ param: { name: "limit", in: "query" } }),
});

export type TokenDto = z.infer<typeof TokenSchema>;
export type CandleDto = z.infer<typeof CandleSchema>;
export type TradeDto = z.infer<typeof TradeSchema>;
export const PriceTickSchema = z
  .object({
    mint: z.string(),
    priceUsd: z.number(),
    marketCapUsd: z.number(),
    time: z.number().int().openapi({ description: "Unix seconds" }),
  })
  .openapi("PriceTick");
export type PriceTick = z.infer<typeof PriceTickSchema>;
export type IntervalValue = z.infer<typeof Interval>;
