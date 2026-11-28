import {
  bigint,
  doublePrecision,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import type { EventRef, Venue } from "../services/chain-ingest/events";
import { tradeSide } from "./trades";

const chainSource = () => text().$type<EventRef["source"]>().notNull();
const whole = () => bigint({ mode: "number" }).notNull();
const price = () => doublePrecision().notNull();

export const chainEvents = pgTable(
  "chain_events",
  { source: chainSource(), signature: text().notNull(), eventIndex: whole() },
  (t) => [primaryKey({ columns: [t.source, t.signature, t.eventIndex] })],
);

export const chainTokens = pgTable(
  "chain_tokens",
  {
    source: chainSource(),
    mint: text().notNull(),
    venue: text().$type<Venue>().notNull(),
    pool: text().notNull(),
    creator: text().notNull(),
    name: text().notNull(),
    symbol: text().notNull(),
    metadataUri: text(),
    imageUrl: text(),
    decimals: integer().notNull(),
    totalSupplyRaw: numeric().notNull(),
    curveProgressBps: integer().notNull().default(0),
    launchedAt: whole(),
    migratedAt: bigint({ mode: "number" }),
    migratedVenue: text().$type<Venue>(),
    priceUsd: price().default(0),
    lastTradeKey: text(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.mint] }),
    index("chain_tokens_launch_idx").on(t.source, t.launchedAt),
    index("chain_tokens_progress_idx").on(t.source, t.curveProgressBps),
    index("chain_tokens_migration_idx").on(t.source, t.migratedAt),
  ],
);

export const chainTrades = pgTable(
  "chain_trades",
  {
    source: chainSource(),
    signature: text().notNull(),
    eventIndex: whole(),
    mint: text().notNull(),
    trader: text().notNull(),
    side: tradeSide().notNull(),
    venue: text().$type<Venue>().notNull(),
    pool: text().notNull(),
    orderKey: text().notNull(),
    time: whole(),
    tokenAmountRaw: numeric().notNull(),
    solAmountLamports: numeric().notNull(),
    priceUsd: price(),
    amountUsd: price(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.signature, t.eventIndex] }),
    foreignKey({ columns: [t.source, t.mint], foreignColumns: [chainTokens.source, chainTokens.mint] }),
    index("chain_trades_mint_time_idx").on(t.source, t.mint, t.time, t.orderKey),
    index("chain_trades_time_idx").on(t.source, t.time),
  ],
);

export const chainCandles = pgTable(
  "chain_candles_1m",
  {
    source: chainSource(),
    mint: text().notNull(),
    time: whole(),
    open: price(),
    high: price(),
    low: price(),
    close: price(),
    volume: price(),
    firstTradeKey: text().notNull(),
    lastTradeKey: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.mint, t.time] }),
    foreignKey({ columns: [t.source, t.mint], foreignColumns: [chainTokens.source, chainTokens.mint] }),
    index("chain_candles_time_idx").on(t.source, t.time),
  ],
);
