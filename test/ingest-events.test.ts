import { describe, expect, it } from "bun:test";
import { ChainEvent, type LaunchEvent, type MigrationEvent, type TradeEvent } from "../src/ingest/events";

const common = {
  signature: "3j32coh9aoWqAb3abJUFgwArTkikK5w7mDZpC7K7sgB2oK8T3fTEfa3zgCmAzT3hk24PV2r7aR1MK6JPVKv1eeW8",
  slot: 350_000_000,
  blockTime: 1_795_805_000,
  ixIndex: 0,
  mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  pool: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
};

const launch: LaunchEvent = {
  ...common,
  kind: "launch",
  venue: "pumpfun",
  creator: "11111111111111111111111111111111",
  name: "Demo Token",
  symbol: "DEMO",
  uri: null,
  imageUrl: null,
  decimals: 6,
  totalSupplyRaw: "9007199254740993",
};

const trade: TradeEvent = {
  ...common,
  kind: "trade",
  venue: "pumpfun",
  trader: launch.creator,
  side: "buy",
  tokenAmountRaw: "3000000",
  solAmountLamports: "1000000",
  bondingCurvePct: 70.5,
};

const migration: MigrationEvent = {
  ...common,
  kind: "migration",
  fromVenue: "pumpfun",
  toVenue: "pumpswap",
};

describe("ChainEvent", () => {
  it.each([
    ["launch", launch],
    ["trade", trade],
    ["migration", migration],
  ])("accepts a %s event", (_kind, event) => {
    expect(ChainEvent.parse(event)).toEqual(event);
  });

  it("accepts a post-migration trade without curve progress", () => {
    const event: TradeEvent = { ...trade, venue: "pumpswap", bondingCurvePct: null };
    expect(ChainEvent.parse(event)).toEqual(event);
  });

  it.each([
    ["a non-base58 creator", { ...launch, creator: "0".repeat(32) }],
    ["an empty trader", { ...trade, trader: "" }],
    ["a short pool address", { ...migration, pool: "short" }],
    ["a negative supply", { ...launch, totalSupplyRaw: "-1" }],
    ["a fractional base-unit amount", { ...trade, tokenAmountRaw: "1.5" }],
    ["a numeric lamports amount", { ...trade, solAmountLamports: 1_000_000 }],
    ["an empty lamports amount", { ...trade, solAmountLamports: "" }],
    ["an out-of-range curve percent", { ...trade, bondingCurvePct: 101 }],
    ["a fractional instruction index", { ...trade, ixIndex: 0.5 }],
  ])("rejects %s", (_description, event) => {
    expect(ChainEvent.safeParse(event).success).toBe(false);
  });
});
