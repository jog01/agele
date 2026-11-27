import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client";
import type { EventPublisher } from "../../events/bus";
import { logger } from "../../lib/logger";
import { chainCandles, chainEvents, chainTokens, chainTrades } from "../../models/chain";
import type { PriceTick, PulseEvent, TradeDto } from "../../schemas/token";
import { SOL_MINT } from "../helius-parser";
import type { ChainFacts, SolUsdPrice } from "./chain-facts";
import type { ChainEvent, ChainEventSink, EventRef } from "./events";
import { marketCap, readPulseToken, type TokenRow, uiAmount } from "./market-read";
import { resolveMetadata } from "./metadata";
import { ChainEventSchema } from "./validation";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Trade = Extract<ChainEvent, { kind: "Trade" }>;
type Change = { source: EventRef["source"]; mint: string };
type BatchResult = {
  changes: Map<string, Change>;
  trades: { trade: TradeDto; tick: PriceTick }[];
  migrations: Extract<PulseEvent, { type: "migrated" }>[];
};

const batch = z.array(ChainEventSchema);
const key = (...fields: number[]) => fields.map((n) => String(n).padStart(16, "0")).join(":");
const order = (event: ChainEvent) => key(event.slot, event.transactionIndex, event.eventIndex);
const tokenKey = ({ source, mint }: Change) =>
  and(eq(chainTokens.source, source), eq(chainTokens.mint, mint));

export class IngestService implements ChainEventSink {
  private readonly nextUpdateAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly publisher: EventPublisher,
    private readonly solUsd: SolUsdPrice,
    private readonly facts: ChainFacts,
    private readonly now = Date.now,
  ) {}

  async ingest(input: readonly ChainEvent[]) {
    const events = batch.parse(input);
    if (!events.length) return;
    if (events.some((event, i) => i > 0 && order(event) < order(events[i - 1]!))) {
      throw new Error("Chain events are not in slot, transaction and event order");
    }
    const result = await this.db.transaction(async (tx) => {
      const result: BatchResult = { changes: new Map(), trades: [], migrations: [] };
      const slotTimes = new Map<number, number>();
      const quotes = new Map<number, number>();
      for (const event of events) {
        if (event.kind === "Trade" && event.quote.mint !== SOL_MINT) continue;
        const [row] =
          event.kind === "TokenLaunched"
            ? []
            : await tx.select().from(chainTokens).where(tokenKey(event)).for("update");
        if (!row && event.kind !== "TokenLaunched" && event.source === "solana") continue;
        const [receipt] = await tx.insert(chainEvents).values(event).onConflictDoNothing().returning();
        if (!receipt) continue;
        const time = event.blockTime ?? slotTimes.get(event.slot) ?? (await this.facts.blockTime(event.slot));
        slotTimes.set(event.slot, time);
        if (event.kind === "TokenLaunched") {
          if (await this.recordLaunch(tx, event, time))
            result.changes.set(`${event.source}:${event.mint}`, event);
          continue;
        }
        if (!row) throw new Error(`Missing indexed launch for ${event.mint}`);
        if (event.kind === "Migrated") {
          if (row.migratedAt !== null) continue;
          await tx
            .update(chainTokens)
            .set({
              migratedAt: time,
              migratedVenue: event.to.venue,
              pool: event.to.address,
            })
            .where(tokenKey(event));
          result.migrations.push({
            type: "migrated",
            mint: event.mint,
            migratedVenue: event.to.venue,
            migratedAt: time,
          });
        } else {
          const solUsd = quotes.get(time) ?? (await this.solUsd.getSolUsd(time));
          quotes.set(time, solUsd);
          result.trades.push(await this.recordTrade(tx, row, event, time, solUsd));
        }
        result.changes.set(`${event.source}:${event.mint}`, event);
      }
      return result;
    });
    await this.publish(result);
  }

  private async recordLaunch(tx: Tx, event: Extract<ChainEvent, { kind: "TokenLaunched" }>, time: number) {
    const [existing] = await tx.select({ mint: chainTokens.mint }).from(chainTokens).where(tokenKey(event));
    if (existing) return false;
    const [metadata, totalSupplyRaw] = await Promise.all([
      resolveMetadata(event.metadataUri),
      this.facts.tokenSupply(event.mint),
    ]);
    const [row] = await tx
      .insert(chainTokens)
      .values({
        ...event,
        venue: event.market.venue,
        pool: event.market.address,
        launchedAt: time,
        totalSupplyRaw,
        metadataUri: event.metadataUri?.includes("\0") ? null : event.metadataUri,
        name: metadata?.name ?? event.mint,
        symbol: metadata?.symbol ?? "Unknown",
        imageUrl: metadata?.imageUrl ?? null,
      })
      .onConflictDoNothing()
      .returning({ mint: chainTokens.mint });
    return !!row;
  }

  private async recordTrade(tx: Tx, row: TokenRow, event: Trade, time: number, solUsd: number) {
    if (
      event.base.mint !== event.mint ||
      event.base.decimals !== row.decimals ||
      event.quote.decimals !== 9
    ) {
      throw new Error("Chain trade legs do not match the indexed token and SOL");
    }
    const tokenAmount = uiAmount(event.base.raw, row.decimals);
    const amountUsd = uiAmount(event.quote.raw, 9) * solUsd;
    const priceUsd = amountUsd / tokenAmount;
    if (
      ![tokenAmount, amountUsd, solUsd, priceUsd].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isFinite(marketCap(row, priceUsd))
    ) {
      throw new Error("Invalid trade amount or SOL price");
    }
    const orderKey = order(event);
    const tradeKey = `${key(time)}:${orderKey}`;
    await tx.insert(chainTrades).values({
      ...event,
      venue: event.market.venue,
      pool: event.market.address,
      time,
      orderKey,
      tokenAmountRaw: event.base.raw,
      solAmountLamports: event.quote.raw,
      priceUsd,
      amountUsd,
    });
    if (!row.lastTradeKey || orderKey > row.lastTradeKey) {
      await tx
        .update(chainTokens)
        .set({
          priceUsd,
          lastTradeKey: orderKey,
          ...(row.migratedAt === null && event.curveProgressBps !== undefined
            ? { curveProgressBps: event.curveProgressBps }
            : {}),
        })
        .where(tokenKey(event));
    }
    await tx
      .insert(chainCandles)
      .values({
        source: event.source,
        mint: event.mint,
        time: Math.floor(time / 60) * 60,
        open: priceUsd,
        high: priceUsd,
        low: priceUsd,
        close: priceUsd,
        volume: amountUsd,
        firstTradeKey: tradeKey,
        lastTradeKey: tradeKey,
      })
      .onConflictDoUpdate({
        target: [chainCandles.source, chainCandles.mint, chainCandles.time],
        set: {
          open: sql`case when excluded.first_trade_key < ${chainCandles.firstTradeKey} then excluded.open else ${chainCandles.open} end`,
          close: sql`case when excluded.last_trade_key > ${chainCandles.lastTradeKey} then excluded.close else ${chainCandles.close} end`,
          high: sql`greatest(${chainCandles.high}, excluded.high)`,
          low: sql`least(${chainCandles.low}, excluded.low)`,
          volume: sql`${chainCandles.volume} + excluded.volume`,
          firstTradeKey: sql`least(${chainCandles.firstTradeKey}, excluded.first_trade_key)`,
          lastTradeKey: sql`greatest(${chainCandles.lastTradeKey}, excluded.last_trade_key)`,
        },
      });
    const { signature, mint, side, trader } = event;
    const trade: TradeDto = { signature, mint, side, trader, tokenAmount, amountUsd, priceUsd, time };
    const tick: PriceTick = { mint, priceUsd, time, marketCapUsd: marketCap(row, priceUsd) };
    return { trade, tick };
  }

  private async publish({ changes, trades, migrations }: BatchResult) {
    const now = this.now();
    for (const [mint, next] of this.nextUpdateAt) if (next <= now) this.nextUpdateAt.delete(mint);
    try {
      for (const { trade, tick } of trades) {
        await this.publisher.publish(`token:${trade.mint}:trades`, trade);
        await this.publisher.publish(`token:${trade.mint}:price`, tick);
      }
      for (const event of migrations) await this.publisher.publish("pulse", event);
      for (const [mint, change] of changes) {
        if (this.nextUpdateAt.has(mint)) continue;
        this.nextUpdateAt.set(mint, now + 1000);
        const [row] = await this.db.select().from(chainTokens).where(tokenKey(change));
        if (!row) continue;
        const token = await readPulseToken(this.db, row, Math.floor(now / 1000));
        await this.publisher.publish("pulse", {
          type: "upsert",
          stage: token.stage,
          token,
        } satisfies PulseEvent);
      }
    } catch (err) {
      logger.warn({ err }, "Chain events committed but realtime publication failed");
    }
  }
}
