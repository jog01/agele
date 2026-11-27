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
  for (const trade of trades) {
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
      const basis = (position.costBasis * sold) / position.quantity;
      position.realizedPnl += (usd * sold) / amount - basis;
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
