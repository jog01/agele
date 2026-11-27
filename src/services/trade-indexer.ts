import { decimal, multiply } from "../lib/decimal";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import type { Trade } from "../models";
import type { TradeRepository } from "../repositories/trade.repository";
import { type EnhancedTransaction, parseTrades, SOL_MINT } from "./helius-parser";
import type { MarketDataProvider } from "./market-data";

export class TradeIndexer {
  private readonly listeners = new Set<(trade: Trade) => void | Promise<void>>();
  private readonly solPrices = new Map<number, Promise<bigint>>();

  constructor(
    private readonly repository: TradeRepository,
    private readonly market: MarketDataProvider,
  ) {}

  onTrade(callback: (trade: Trade) => void | Promise<void>) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private historicalSolPrice(timestamp: number) {
    const minute = Math.floor(timestamp / 60) * 60;
    const cached = this.solPrices.get(minute);
    if (cached) return cached;
    const lookup = Promise.resolve().then(async () => {
      const price = await this.market.getHistoricalPriceUsd(SOL_MINT, minute);
      if (price === null || !Number.isFinite(price) || price <= 0) {
        throw new AppError(503, "price_unavailable", "Historical SOL/USD price unavailable");
      }
      return decimal(price.toFixed(18));
    });
    this.solPrices.set(minute, lookup);
    if (this.solPrices.size > 2048) this.solPrices.delete(this.solPrices.keys().next().value!);
    void lookup.catch(() => {
      if (this.solPrices.get(minute) === lookup) this.solPrices.delete(minute);
    });
    return lookup;
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
        const solPriceUsd =
          trade.quoteMint === SOL_MINT ? await this.historicalSolPrice(trade.timestamp) : undefined;
        const usd = solPriceUsd === undefined ? trade.quoteAmount : multiply(trade.quoteAmount, solPriceUsd);
        const metadata = await this.market.getToken(trade.mint);
        const stored = await this.repository.record({
          ...trade,
          usd,
          solPriceUsd,
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
