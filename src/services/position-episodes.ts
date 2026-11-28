import { decimal } from "../lib/decimal";
import type { Trade } from "../models";

export interface PositionEpisode {
  id: string;
  mint: string;
  openedAt: Date;
  closedAt: Date | null;
  quantity: bigint;
  costBasis: bigint;
  invested: bigint;
  bought: bigint;
  realizedPnl: bigint;
  fills: Trade[];
}

export function positionEpisodes(trades: Trade[]) {
  const episodes: PositionEpisode[] = [];
  const open = new Map<string, PositionEpisode>();
  const ordered = trades.toSorted(
    (a, b) =>
      a.executedAt.getTime() - b.executedAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      Number(a.side === "sell") - Number(b.side === "sell") ||
      a.id.localeCompare(b.id),
  );
  for (const trade of ordered) {
    let position = open.get(trade.mint);
    const amount = decimal(trade.tokenAmount);
    const usd = decimal(trade.quoteAmountUsd);
    if (amount <= 0n) continue;
    if (trade.side === "buy") {
      if (!position) {
        position = {
          id: trade.id,
          mint: trade.mint,
          openedAt: trade.executedAt,
          closedAt: null,
          quantity: 0n,
          costBasis: 0n,
          invested: 0n,
          bought: 0n,
          realizedPnl: 0n,
          fills: [],
        };
        episodes.push(position);
        open.set(trade.mint, position);
      }
      position.quantity += amount;
      position.costBasis += usd;
      position.invested += usd;
      position.bought += amount;
    } else {
      if (!position) continue;
      let sold = amount;
      if (sold > position.quantity) sold = position.quantity;
      const proceeds = (usd * sold) / amount;
      const weightedBasis = (position.costBasis * sold) / position.quantity;
      const realized =
        trade.realizedPnlUsd === null ? proceeds - weightedBasis : decimal(trade.realizedPnlUsd);
      const impliedBasis = proceeds - realized;
      const basis =
        sold === position.quantity || impliedBasis < 0n || impliedBasis > position.costBasis
          ? weightedBasis
          : impliedBasis;
      position.realizedPnl += realized;
      position.quantity -= sold;
      position.costBasis -= basis;
      if (!position.quantity) {
        position.closedAt = trade.executedAt;
        open.delete(trade.mint);
      }
    }
    position.fills.push(trade);
  }
  return episodes;
}

/** Token-weighted average market cap of one side's fills, or null when any fill lacks cap data. */
export const weightedCap = (fills: Trade[], side: Trade["side"]) => {
  let total = 0;
  let amount = 0;
  for (const fill of fills) {
    if (fill.side !== side) continue;
    if (fill.marketCapUsd === null) return null;
    const size = Number(fill.tokenAmount);
    total += size * Number(fill.marketCapUsd);
    amount += size;
  }
  return amount > 0 ? total / amount : null;
};
