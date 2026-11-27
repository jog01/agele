import { describe, expect, it } from "bun:test";
import type { ChainEvent } from "../src/services/chain-ingest/events";
import { ChainEventSchema } from "../src/services/chain-ingest/validation";

const sol = "So11111111111111111111111111111111111111112";
const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const trader = "11111111111111111111111111111111";
const market = { address: mint, venue: "pump.fun", programId: trader } as const;
const ref = {
  source: "solana",
  signature: "signature",
  slot: 1,
  transactionIndex: 0,
  eventIndex: 0,
  blockTime: null,
  mint,
} as const;
const launch: ChainEvent = { ...ref, kind: "TokenLaunched", market, creator: trader, decimals: 6 };
const trade: ChainEvent = {
  ...ref,
  kind: "Trade",
  market,
  trader,
  side: "buy",
  base: { mint, raw: "9007199254740993", decimals: 6 },
  quote: { mint: sol, raw: "1000000", decimals: 9 },
  curveProgressBps: 7000,
};
const migration: ChainEvent = {
  ...ref,
  kind: "Migrated",
  from: market,
  to: { ...market, venue: "raydium-cpmm" },
};

describe("ChainEventSchema", () => {
  it.each([
    ["launch", launch],
    ["trade", trade],
    ["migration", migration],
  ])("accepts %s", (_kind, event) => {
    expect(ChainEventSchema.parse(event)).toEqual(event);
  });

  it.each([
    ["an invalid address", { ...launch, creator: "0".repeat(32) }],
    ["an empty amount", { ...trade, base: { ...trade.base, raw: "" } }],
    ["a fractional amount", { ...trade, quote: { ...trade.quote, raw: "1.5" } }],
    ["a fractional transaction index", { ...trade, transactionIndex: 0.5 }],
    ["an invalid curve progress", { ...trade, curveProgressBps: 10_001 }],
    ["an unsplit venue", { ...migration, to: { ...market, venue: "meteora" } }],
  ])("rejects %s", (_description, event) => {
    expect(ChainEventSchema.safeParse(event).success).toBe(false);
  });
});
