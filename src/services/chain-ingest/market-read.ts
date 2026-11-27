import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { chainTokens } from "../../models/chain";
import type { PulseStage, PulseToken, TokenDto } from "../../schemas/token";
import type { EventRef } from "./events";

export type TokenRow = typeof chainTokens.$inferSelect;
export const FINAL_STRETCH_BPS = 7000;

export function uiAmount(raw: string, decimals: number) {
  return Number(raw) / 10 ** decimals;
}

export function holderPositions(source: EventRef["source"], mint: string) {
  return sql`
    SELECT trader AS wallet, sum(CASE side WHEN 'buy' THEN token_amount_raw ELSE -token_amount_raw END) AS raw
    FROM chain_trades WHERE source = ${source} AND mint = ${mint}
    GROUP BY trader
    HAVING sum(CASE side WHEN 'buy' THEN token_amount_raw ELSE -token_amount_raw END) > 0
  `;
}

export async function tokenStats(db: Db, row: TokenRow, now: number) {
  const cutoff = now - 86_400;
  const [stats] = await db.execute<{
    volume: number;
    previous: number;
    holders: number;
    netUsd: number;
    buys: number;
    sells: number;
  }>(sql`
    SELECT
      coalesce(sum(amount_usd) FILTER (WHERE time >= ${cutoff}), 0) AS volume,
      coalesce(sum(CASE side WHEN 'buy' THEN amount_usd ELSE -amount_usd END), 0) AS "netUsd",
      count(*) FILTER (WHERE time >= ${cutoff} AND side = 'buy')::int AS buys,
      count(*) FILTER (WHERE time >= ${cutoff} AND side = 'sell')::int AS sells,
      coalesce((
        SELECT price_usd FROM chain_trades WHERE source = ${row.source} AND mint = ${row.mint} AND time <= ${cutoff}
        ORDER BY time DESC, order_key DESC LIMIT 1
      ), (
        SELECT price_usd FROM chain_trades WHERE source = ${row.source} AND mint = ${row.mint}
        ORDER BY time, order_key LIMIT 1
      ), 0) AS previous,
      (SELECT count(*)::int FROM (${holderPositions(row.source, row.mint)}) positions) AS holders
    FROM chain_trades WHERE source = ${row.source} AND mint = ${row.mint}
  `);
  return stats!;
}

export function marketCap(row: TokenRow, priceUsd = row.priceUsd) {
  return uiAmount(row.totalSupplyRaw, row.decimals) * priceUsd;
}

export function tokenDto(row: TokenRow, stats: Awaited<ReturnType<typeof tokenStats>>): TokenDto {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    imageUrl: row.imageUrl,
    priceUsd: row.priceUsd,
    priceChange24hPct: stats.previous ? (row.priceUsd / stats.previous - 1) * 100 : 0,
    marketCapUsd: marketCap(row),
    liquidityUsd: Math.max(0, stats.netUsd) * 2,
    volume24hUsd: stats.volume,
    holders: stats.holders,
  };
}

export async function readPulseToken(db: Db, row: TokenRow, now: number): Promise<PulseToken> {
  const stats = await tokenStats(db, row, now);
  const { decimals: _decimals, priceChange24hPct: _change, ...token } = tokenDto(row, stats);
  const stage: PulseStage =
    row.migratedAt !== null ? "migrated" : row.curveProgressBps >= FINAL_STRETCH_BPS ? "finalStretch" : "new";
  return {
    ...token,
    stage,
    curveProgressBps: row.curveProgressBps,
    venue: row.venue,
    creator: row.creator,
    launchedAt: row.launchedAt,
    migratedAt: row.migratedAt,
    migratedVenue: row.migratedVenue,
    txCount24h: stats.buys + stats.sells,
    buys24h: stats.buys,
    sells24h: stats.sells,
  };
}
