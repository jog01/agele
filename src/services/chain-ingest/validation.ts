import { z } from "zod";
import type { ChainEvent } from "./events";

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const VenueSchema = z.enum([
  "pump.fun",
  "pumpswap",
  "raydium-v4",
  "raydium-cpmm",
  "raydium-clmm",
  "meteora-dlmm",
  "meteora-damm",
]);
const index = z.int().nonnegative();
const decimals = z.int().min(0).max(255);
const market = z.object({ address, venue: VenueSchema, programId: address });
const amount = z.object({ mint: address, raw: z.string().regex(/^\d+$/), decimals });
const eventRef = {
  source: z.enum(["demo", "solana"]),
  signature: z.string().min(1),
  slot: index,
  transactionIndex: index,
  eventIndex: index,
  blockTime: index.nullable(),
  mint: address,
};

export const ChainEventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...eventRef,
    kind: z.literal("TokenLaunched"),
    market,
    creator: address,
    decimals,
    metadataUri: z.string().optional(),
  }),
  z.object({
    ...eventRef,
    kind: z.literal("Trade"),
    market,
    trader: address,
    side: z.enum(["buy", "sell"]),
    base: amount,
    quote: amount,
    curveProgressBps: z.int().min(0).max(10_000).optional(),
  }),
  z.object({ ...eventRef, kind: z.literal("Migrated"), from: market, to: market }),
]);

type Assert<T extends true> = T;
export type ChainEventSchemaMatchesContract = Assert<
  [z.infer<typeof ChainEventSchema>] extends [ChainEvent]
    ? [ChainEvent] extends [z.infer<typeof ChainEventSchema>]
      ? true
      : false
    : false
>;
