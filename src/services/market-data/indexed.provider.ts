import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { AppError } from "../../lib/errors";
import { chainCandles, chainTokens, chainTrades } from "../../models/chain";
import type { CandleDto, IntervalValue, PulseDto, TokenDto, TokenHoldersDto } from "../../schemas/token";
import type { SolUsdPrice } from "../chain-ingest/chain-facts";
import type { EventRef } from "../chain-ingest/events";
import {
  FINAL_STRETCH_BPS,
  holderPositions,
  readPulseToken,
  type TokenRow,
  tokenDto,
  tokenStats,
  uiAmount,
} from "../chain-ingest/market-read";
import { SOL_MINT } from "../helius-parser";
import { INTERVAL_SECONDS, type MarketDataProvider } from "./provider";

interface Options {
  source: EventRef["source"];
  solUsd: SolUsdPrice;
  upstream: MarketDataProvider;
  upstreamTrending?: boolean;
  now?: () => number;
}

function hasIndexedMarketData(token: TokenRow | undefined): token is TokenRow {
  return !!token && (token.source === "demo" || token.lastTradeKey !== null || token.priceUsd > 0);
}

export class IndexedMarketDataProvider implements MarketDataProvider {
  readonly name = "indexed";
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }

  private seconds() {
    return Math.floor(this.now() / 1000);
  }

  private tokens() {
    return this.db.select().from(chainTokens);
  }

  private async indexedToken(mint: string, source = this.options.source) {
    const [token] = await this.tokens().where(
      and(eq(chainTokens.source, source), eq(chainTokens.mint, mint)),
    );
    return token;
  }

  async getExternalToken(mint: string) {
    if (hasIndexedMarketData(await this.indexedToken(mint))) return null;
    return this.getFallbackToken(mint);
  }

  private async getFallbackToken(mint: string): Promise<TokenDto | null> {
    if (mint !== SOL_MINT || this.options.source !== "demo") return this.options.upstream.getToken(mint);
    return {
      mint,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      imageUrl:
        "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
      priceUsd: await this.options.solUsd.getSolUsd(this.seconds()),
      priceChange24hPct: 0,
      marketCapUsd: 0,
      liquidityUsd: 0,
      volume24hUsd: 0,
      holders: 0,
    };
  }

  async getToken(mint: string) {
    const row = await this.indexedToken(mint);
    if (!row) return this.getFallbackToken(mint);
    if (!hasIndexedMarketData(row)) {
      const upstream = await this.getFallbackToken(mint);
      if (upstream) return upstream;
    }
    return tokenDto(row, await tokenStats(this.db, row, this.seconds()));
  }

  async getIndexedToken(mint: string, source: EventRef["source"]) {
    const row = await this.indexedToken(mint, source);
    if (source === "solana" && (!row || !Number.isFinite(row.priceUsd) || row.priceUsd <= 0)) return null;
    return hasIndexedMarketData(row) ? tokenDto(row, await tokenStats(this.db, row, this.seconds())) : null;
  }

  async getHistoricalPriceUsd(mint: string, minute: number) {
    if (mint === SOL_MINT && this.options.source === "demo") return this.options.solUsd.getSolUsd(minute);
    const token = await this.indexedToken(mint);
    if (!hasIndexedMarketData(token)) return this.options.upstream.getHistoricalPriceUsd(mint, minute);
    const [candle] = await this.db
      .select({ open: chainCandles.open })
      .from(chainCandles)
      .where(
        and(
          eq(chainCandles.source, token.source),
          eq(chainCandles.mint, mint),
          eq(chainCandles.time, minute),
        ),
      );
    return candle?.open ?? null;
  }

  async listTrending(limit: number) {
    if (this.options.upstreamTrending) return this.options.upstream.listTrending(limit);
    const now = this.seconds();
    const rows = await this.tokens()
      .where(eq(chainTokens.source, this.options.source))
      .orderBy(
        sql`(select coalesce(sum(amount_usd), 0) from chain_trades
        where source = ${chainTokens.source} and mint = ${chainTokens.mint} and time >= ${now - 86_400}) desc`,
        desc(chainTokens.launchedAt),
        chainTokens.mint,
      )
      .limit(limit);
    return Promise.all(rows.map(async (row) => tokenDto(row, await tokenStats(this.db, row, now))));
  }

  async searchTokens(query: string) {
    const prefix = query.toLowerCase();
    const rows = await this.tokens()
      .where(
        and(
          eq(chainTokens.source, this.options.source),
          sql`(${chainTokens.mint} = ${query} or starts_with(lower(${chainTokens.symbol}), ${prefix}) or starts_with(lower(${chainTokens.name}), ${prefix}))`,
        ),
      )
      .orderBy(desc(sql`${chainTokens.mint} = ${query}`), desc(chainTokens.launchedAt), chainTokens.mint)
      .limit(30);
    const demoSol = query === SOL_MINT && this.options.source === "demo";
    const upstream =
      (await this.options.upstream.searchTokens?.(query).catch((err: unknown) => {
        if (!rows.length && !demoSol) throw err;
        return [];
      })) ?? [];
    const now = this.seconds();
    const upstreamByMint = new Map(upstream.map((token) => [token.mint, token]));
    const indexed = await Promise.all(
      rows.map(async (row) => {
        const external = upstreamByMint.get(row.mint);
        if (external && !hasIndexedMarketData(row)) return external;
        return tokenDto(row, await tokenStats(this.db, row, now));
      }),
    );
    const tokens = new Map<string, TokenDto>();
    for (const token of [...indexed, ...upstream]) {
      if (!tokens.has(token.mint)) tokens.set(token.mint, token);
    }
    if (this.options.source === "demo" && (demoSol || tokens.has(SOL_MINT))) {
      const sol = await this.getToken(SOL_MINT);
      if (sol) tokens.set(SOL_MINT, sol);
    }
    const exact = tokens.get(query);
    tokens.delete(query);
    return exact ? [exact, ...tokens.values()] : [...tokens.values()];
  }

  async listPulse(limit: number): Promise<PulseDto> {
    const source = eq(chainTokens.source, this.options.source);
    const active = isNull(chainTokens.migratedAt);
    const now = this.seconds();
    const [fresh, stretch, migrated] = await Promise.all([
      this.tokens()
        .where(and(source, active, lt(chainTokens.curveProgressBps, FINAL_STRETCH_BPS)))
        .orderBy(desc(chainTokens.launchedAt), chainTokens.mint)
        .limit(limit),
      this.tokens()
        .where(and(source, active, gte(chainTokens.curveProgressBps, FINAL_STRETCH_BPS)))
        .orderBy(desc(chainTokens.curveProgressBps), desc(chainTokens.launchedAt), chainTokens.mint)
        .limit(limit),
      this.tokens()
        .where(and(source, isNotNull(chainTokens.migratedAt)))
        .orderBy(desc(chainTokens.migratedAt), chainTokens.mint)
        .limit(limit),
    ]);
    const map = (rows: typeof fresh) => Promise.all(rows.map((row) => readPulseToken(this.db, row, now)));
    const [freshTokens, stretchTokens, migratedTokens] = await Promise.all([
      map(fresh),
      map(stretch),
      map(migrated),
    ]);
    return {
      source: this.options.source === "demo" ? "demo" : "indexed",
      new: freshTokens,
      finalStretch: stretchTokens,
      migrated: migratedTokens,
    };
  }

  async getCandles(mint: string, interval: IntervalValue, limit: number) {
    const token = await this.indexedToken(mint);
    if (!hasIndexedMarketData(token)) return this.options.upstream.getCandles(mint, interval, limit);
    const seconds = INTERVAL_SECONDS[interval];
    if (interval === "1m") {
      const result = await this.db.execute<CandleDto>(sql`
        select time::float8, open, high, low, close, volume from chain_candles_1m
        where source = ${token.source} and mint = ${mint} order by time desc limit ${limit}
      `);
      return [...result].reverse();
    }
    const result = await this.db.execute<CandleDto>(sql`
      select bucket::float8 as time, (array_agg(open order by time))[1] as open,
        max(high) as high, min(low) as low, (array_agg(close order by time desc))[1] as close, sum(volume) as volume
      from (select *, time / ${seconds}::bigint * ${seconds}::bigint as bucket from chain_candles_1m
        where source = ${token.source} and mint = ${mint}) candles
      group by bucket order by bucket desc limit ${limit}
    `);
    return [...result].reverse();
  }

  async getRecentTrades(mint: string, limit: number) {
    const token = await this.indexedToken(mint);
    if (!hasIndexedMarketData(token)) return this.options.upstream.getRecentTrades(mint, limit);
    const rows = await this.db
      .select()
      .from(chainTrades)
      .where(and(eq(chainTrades.source, token.source), eq(chainTrades.mint, mint)))
      .orderBy(desc(chainTrades.time), desc(chainTrades.orderKey))
      .limit(limit);
    return rows.map((row) => ({
      mint,
      signature: row.signature,
      side: row.side,
      trader: row.trader,
      time: row.time,
      tokenAmount: uiAmount(row.tokenAmountRaw, token.decimals),
      amountUsd: row.amountUsd,
      priceUsd: row.priceUsd,
    }));
  }

  async getHolders(mint: string, limit: number): Promise<TokenHoldersDto> {
    const token = await this.indexedToken(mint);
    const knownMint = token !== undefined;
    if (!hasIndexedMarketData(token)) {
      if (mint !== SOL_MINT || this.options.source !== "demo") {
        try {
          return await this.options.upstream.getHolders(mint, limit);
        } catch (err) {
          if (!knownMint || !(err instanceof AppError) || err.status !== 404) throw err;
        }
      }
      return { mint, totalHolders: 0, top10Pct: 0, holders: [], updatedAt: this.seconds() };
    }
    const rows = await this.db.execute<{ wallet: string; raw: string; total: number }>(sql`
      SELECT wallet, raw, count(*) over ()::int AS total FROM (${holderPositions(token.source, mint)}) positions
      ORDER BY raw DESC, wallet LIMIT ${Math.max(limit, 10)}
    `);
    const supply = uiAmount(token.totalSupplyRaw, token.decimals);
    const holders = rows.map(({ wallet, raw }, i) => {
      const amount = uiAmount(raw, token.decimals);
      return {
        rank: i + 1,
        wallet,
        amount,
        pctSupply: supply ? (amount / supply) * 100 : 0,
        valueUsd: amount * token.priceUsd,
      };
    });
    return {
      mint,
      totalHolders: rows[0]?.total ?? 0,
      top10Pct: holders.slice(0, 10).reduce((sum, h) => sum + h.pctSupply, 0),
      holders: holders.slice(0, limit),
      updatedAt: this.seconds(),
    };
  }
}
