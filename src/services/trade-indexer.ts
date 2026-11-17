import { decimal, multiply } from "../lib/decimal";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { Trade } from "../models";
import type { TradeRepository } from "../repositories/trade.repository";
import { type EnhancedTransaction, parseTrades, SOL_MINT } from "./helius-parser";
import type { MarketDataProvider } from "./market-data";

export class TradeIndexer {
  private readonly listeners = new Set<(trade: Trade) => void | Promise<void>>();

  constructor(
    private readonly repository: TradeRepository,
    private readonly market: MarketDataProvider,
  ) {}

  onTrade(callback: (trade: Trade) => void | Promise<void>) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  async index(transactions: EnhancedTransaction[]) {
    let indexed = 0;
    let skipped = 0;
    for (const tx of transactions) {
      const addresses = new Set(
        tx.accountData.flatMap((account) => [
          account.account,
          ...account.tokenBalanceChanges.map((change) => change.userAccount),
        ]),
      );
      const linked = await this.repository.linkedWallets([...addresses]);
      const parsed = parseTrades(tx, new Set(linked.map((wallet) => wallet.address)));
      if (!parsed.length) skipped++;
      for (const trade of parsed) {
        let usd = trade.quoteAmount;
        if (trade.quoteMint === SOL_MINT) {
          // TODO: use historical SOL pricing at the transaction timestamp.
          const sol = await this.market.getToken(SOL_MINT);
          if (!sol || !Number.isFinite(sol.priceUsd) || sol.priceUsd <= 0) {
            throw new AppError(503, "price_unavailable", "SOL price unavailable");
          }
          usd = multiply(usd, decimal(sol.priceUsd.toFixed(18)));
        }
        const metadata = await this.market.getToken(trade.mint);
        const stored = await this.repository.record({
          ...trade,
          usd,
          userId: linked.find((wallet) => wallet.address === trade.wallet)!.userId,
          symbol: metadata?.symbol ?? trade.mint.slice(0, 8),
          name: metadata?.name ?? trade.mint.slice(0, 8),
          imageUrl: metadata?.imageUrl ?? null,
        });
        if (!stored) {
          skipped++;
          continue;
        }
        indexed++;
        for (const listener of this.listeners) {
          try {
            await listener(stored);
          } catch (err) {
            logger.error({ err, signature: stored.signature }, "Trade listener failed");
          }
        }
      }
    }
    return { indexed, skipped };
  }
}
