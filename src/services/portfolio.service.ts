import { z } from "zod";
import { badRequest } from "../lib/errors";
import type { PgPortfolioRepository, TradeCursor } from "../repositories/portfolio.repository";
import { SOL_MINT } from "./helius-parser";
import type { MarketDataProvider } from "./market-data";
import type { WalletBalanceProvider } from "./wallet-balance.provider";

const cursorSchema = z.object({ executedAt: z.iso.datetime(), id: z.uuid() });
export type HistoryRange = "7d" | "30d" | "all";

export function decodeTradeCursor(cursor: string): TradeCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid encoding");
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error("Invalid encoding");
    const parsed = cursorSchema.parse(JSON.parse(decoded.toString()));
    return { executedAt: new Date(parsed.executedAt), id: parsed.id };
  } catch {
    throw badRequest("Invalid trades cursor");
  }
}

export class PortfolioService {
  constructor(
    private readonly repository: PgPortfolioRepository,
    private readonly market: MarketDataProvider,
    private readonly balances: WalletBalanceProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async getPortfolio(userId: string) {
    const [summary, wallets] = await Promise.all([
      this.getPositionSummary(userId),
      this.repository.getWallets(userId),
    ]);
    const { usdcBalance, usdtBalance, solBalance } = await this.balances.getBalances(
      wallets.map((wallet) => wallet.address),
    );
    const solPrice = solBalance > 0 ? (await this.market.getToken(SOL_MINT))?.priceUsd : 0;
    const solValueUsd = solPrice && Number.isFinite(solPrice) && solPrice > 0 ? solBalance * solPrice : 0;
    return {
      equityUsd:
        usdcBalance +
        usdtBalance +
        solValueUsd +
        summary.positions.reduce((sum, position) => sum + position.valueUsd, 0),
      usdcBalance,
      ...summary,
    };
  }

  async getPositionSummary(userId: string) {
    const rows = await this.repository.getPositions(userId);
    const positions = await Promise.all(
      rows
        .filter(({ position }) => Number(position.quantity) > 0)
        .map(async ({ position, symbol }) => {
          const quantity = Number(position.quantity);
          const cost = Number(position.costBasisUsd);
          const avgCostUsd = cost / quantity;
          const token = await this.market.getToken(position.mint);
          const hasPrice = token && Number.isFinite(token.priceUsd) && token.priceUsd > 0;
          const priceUsd = hasPrice ? token.priceUsd : avgCostUsd;
          const valueUsd = hasPrice ? quantity * priceUsd : cost;
          return {
            mint: position.mint,
            symbol,
            quantity,
            avgCostUsd,
            priceUsd,
            valueUsd,
            unrealizedPnlUsd: valueUsd - cost,
            realizedPnlUsd: Number(position.realizedPnlUsd),
          };
        }),
    );
    return {
      unrealizedPnlUsd: positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0),
      realizedPnlUsd: rows.reduce((sum, { position }) => sum + Number(position.realizedPnlUsd), 0),
      positions,
    };
  }

  async getHistory(userId: string, range: HistoryRange) {
    const now = this.now();
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    if (range !== "all") start.setUTCDate(start.getUTCDate() - (range === "7d" ? 7 : 30));
    const [snapshots, live] = await Promise.all([
      this.repository.history(userId, range === "all" ? undefined : start.toISOString().slice(0, 10)),
      this.getPortfolio(userId),
    ]);
    return {
      points: [
        ...snapshots.map((snapshot) => ({
          time: Date.parse(`${snapshot.day}T00:00:00Z`) / 1000,
          valueUsd: Number(snapshot.valueUsd),
        })),
        { time: Math.floor(now / 1000), valueUsd: live.equityUsd },
      ],
    };
  }

  async getTrades(userId: string, limit: number, cursor?: string) {
    const rows = await this.repository.getTrades(
      userId,
      limit + 1,
      cursor === undefined ? undefined : decodeTradeCursor(cursor),
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.trade;
    return {
      trades: page.map(({ trade, symbol }) => ({
        id: trade.id,
        signature: trade.signature,
        mint: trade.mint,
        symbol,
        side: trade.side,
        tokenAmount: Number(trade.tokenAmount),
        priceUsd: Number(trade.priceUsd),
        valueUsd: Number(trade.quoteAmountUsd),
        realizedPnlUsd:
          trade.side === "buy" || trade.realizedPnlUsd === null ? null : Number(trade.realizedPnlUsd),
        time: Math.floor(trade.executedAt.getTime() / 1000),
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ executedAt: last.executedAt.toISOString(), id: last.id })).toString(
              "base64url",
            )
          : null,
    };
  }
}
