import { z } from "zod";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const rawAmount = z.string().regex(/^\d+$/);

export const Venue = z.enum(["pumpfun", "pumpswap", "raydium", "meteora"]);
export type Venue = z.infer<typeof Venue>;

const eventFields = {
  signature: z.string().min(1),
  slot: z.int().nonnegative(),
  blockTime: z.int().nonnegative(),
  ixIndex: z.int().nonnegative(),
};

export const LaunchEvent = z.object({
  ...eventFields,
  kind: z.literal("launch"),
  venue: Venue,
  mint: address,
  creator: address,
  name: z.string(),
  symbol: z.string(),
  uri: z.string().nullable(),
  imageUrl: z.string().nullable(),
  decimals: z.int().min(0).max(255),
  totalSupplyRaw: rawAmount,
  pool: address,
});
export type LaunchEvent = z.infer<typeof LaunchEvent>;

export const TradeEvent = z.object({
  ...eventFields,
  kind: z.literal("trade"),
  venue: Venue,
  pool: address,
  mint: address,
  trader: address,
  side: z.enum(["buy", "sell"]),
  tokenAmountRaw: rawAmount,
  solAmountLamports: rawAmount,
  bondingCurvePct: z.number().min(0).max(100).nullable(),
});
export type TradeEvent = z.infer<typeof TradeEvent>;

export const MigrationEvent = z.object({
  ...eventFields,
  kind: z.literal("migration"),
  mint: address,
  fromVenue: Venue,
  toVenue: Venue,
  pool: address,
});
export type MigrationEvent = z.infer<typeof MigrationEvent>;

export const ChainEvent = z.discriminatedUnion("kind", [LaunchEvent, TradeEvent, MigrationEvent]);
export type ChainEvent = z.infer<typeof ChainEvent>;
