import { notFound } from "../../lib/errors";
import { hash, mulberry32 } from "../../lib/prng";
import type { CandleDto, IntervalValue, TokenDto, TokenHoldersDto, TradeDto } from "../../schemas/token";
import { INTERVAL_SECONDS, type MarketDataProvider } from "./provider";

type Seed = Pick<TokenDto, "mint" | "symbol" | "name" | "decimals"> & {
  price: number;
  supply: number;
};

const SEEDS: Seed[] = [
  {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Wrapped SOL",
    decimals: 9,
    price: 182.4,
    supply: 590e6,
  },
  {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    symbol: "JUP",
    name: "Jupiter",
    decimals: 6,
    price: 0.94,
    supply: 3e9,
  },
  {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    name: "Bonk",
    decimals: 5,
    price: 0.0000231,
    supply: 88e12,
  },
  {
    mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    symbol: "WIF",
    name: "dogwifhat",
    decimals: 6,
    price: 1.87,
    supply: 998e6,
  },
  {
    mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
    symbol: "TRUMP",
    name: "OFFICIAL TRUMP",
    decimals: 6,
    price: 9.12,
    supply: 1e9,
  },
  {
    mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
    symbol: "PENGU",
    name: "Pudgy Penguins",
    decimals: 6,
    price: 0.0312,
    supply: 88e9,
  },
  {
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    symbol: "PYTH",
    name: "Pyth Network",
    decimals: 6,
    price: 0.152,
    supply: 10e9,
  },
  {
    mint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    symbol: "PUMP",
    name: "Pump",
    decimals: 6,
    price: 0.0058,
    supply: 1e12,
  },
];

const TRADER_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export class MockMarketDataProvider implements MarketDataProvider {
  readonly name = "mock";

  constructor(private readonly now: () => number = () => Date.now()) {}

  async listTrending(limit: number) {
    const all = SEEDS.map((s) => this.toToken(s));
    return all.sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, limit);
  }

  async getToken(mint: string) {
    const seed = SEEDS.find((s) => s.mint === mint);
    return seed ? this.toToken(seed) : null;
  }

  async getHistoricalPriceUsd(mint: string, minute: number) {
    const seed = SEEDS.find((s) => s.mint === mint);
    return seed ? this.priceAt(seed, minute) : null;
  }

  async getCandles(mint: string, interval: IntervalValue, limit: number) {
    const seed = SEEDS.find((s) => s.mint === mint);
    if (!seed) return [];
    const step = INTERVAL_SECONDS[interval];
    const end = Math.floor(this.now() / 1000 / step) * step;
    const candles: CandleDto[] = [];
    for (let i = limit - 1; i >= 0; i--) {
      const time = end - i * step;
      candles.push(this.candleAt(seed, time, step));
    }
    return candles;
  }

  async getRecentTrades(mint: string, limit: number) {
    const seed = SEEDS.find((s) => s.mint === mint);
    if (!seed) return [];
    const nowSec = Math.floor(this.now() / 1000);
    const trades: TradeDto[] = [];
    for (let i = 0; i < limit; i++) trades.push(this.tradeAt(seed, nowSec - i * 7, i));
    return trades;
  }

  /** One synthetic trade for the live feed. */
  tradeAt(seed: Seed | string, time: number, salt = 0): TradeDto {
    const s = typeof seed === "string" ? SEEDS.find((x) => x.mint === seed) : seed;
    if (!s) throw new Error(`unknown mint ${seed}`);
    const rand = mulberry32(hash(`${s.mint}:${time}:${salt}`));
    const price = this.priceAt(s, time);
    const amountUsd = Math.round(10 ** (1 + rand() * 3.5) * 100) / 100;
    const trader = Array.from(
      { length: 44 },
      () => TRADER_ALPHABET[Math.floor(rand() * TRADER_ALPHABET.length)],
    ).join("");
    return {
      signature: `mock${hash(`${s.mint}${time}${salt}`).toString(36)}${Math.floor(rand() * 1e9).toString(36)}`,
      mint: s.mint,
      side: rand() > 0.45 ? "buy" : "sell",
      trader,
      tokenAmount: amountUsd / price,
      amountUsd,
      priceUsd: price,
      time,
    };
  }

  static readonly mints = SEEDS.map((s) => s.mint);

  async getHolders(mint: string, limit: number): Promise<TokenHoldersDto> {
    const seed = SEEDS.find((s) => s.mint === mint);
    if (!seed) throw notFound("Token");
    const token = this.toToken(seed);
    const rand = mulberry32(hash(`${mint}:holders`));
    const holders = Array.from({ length: 20 }, (_, i) => {
      const pctSupply = 8 / (i + 1);
      const amount = (seed.supply * pctSupply) / 100;
      return {
        rank: i + 1,
        wallet: Array.from(
          { length: 44 },
          () => TRADER_ALPHABET[Math.floor(rand() * TRADER_ALPHABET.length)],
        ).join(""),
        amount,
        pctSupply,
        valueUsd: amount * token.priceUsd,
        isPool: false,
      };
    });
    return {
      mint,
      totalHolders: token.holders,
      top10Pct: holders.slice(0, 10).reduce((sum, h) => sum + h.pctSupply, 0),
      holders: holders.slice(0, limit),
      updatedAt: Math.floor(this.now() / 1000),
    };
  }

  private priceAt(s: Seed, time: number) {
    // Smooth pseudo-random walk: sum of a few sines keyed by the mint.
    const h = hash(s.mint);
    const t = time / 3600;
    const drift =
      0.06 * Math.sin(t / 9 + (h % 7)) +
      0.025 * Math.sin(t / 2.3 + (h % 11)) +
      0.01 * Math.sin(t * 1.7 + (h % 13)) +
      0.004 * Math.sin(t * 9.1 + (h % 17));
    return s.price * (1 + drift);
  }

  private candleAt(s: Seed, time: number, step: number): CandleDto {
    const open = this.priceAt(s, time);
    const close = this.priceAt(s, time + step);
    const rand = mulberry32(hash(`${s.mint}:${time}:${step}`));
    const wick = Math.abs(close - open) * (0.3 + rand()) + open * 0.0015 * rand();
    return {
      time,
      open,
      high: Math.max(open, close) + wick,
      low: Math.max(0, Math.min(open, close) - wick),
      close,
      volume: Math.round(s.price * s.supply * 1e-6 * (0.2 + rand()) * (step / 300)),
    };
  }

  private toToken(s: Seed): TokenDto {
    const nowSec = Math.floor(this.now() / 1000);
    const price = this.priceAt(s, nowSec);
    const dayAgo = this.priceAt(s, nowSec - 86_400);
    const rand = mulberry32(hash(s.mint));
    const marketCapUsd = price * s.supply;
    return {
      mint: s.mint,
      symbol: s.symbol,
      name: s.name,
      decimals: s.decimals,
      imageUrl: null,
      priceUsd: price,
      priceChange24hPct: ((price - dayAgo) / dayAgo) * 100,
      marketCapUsd,
      liquidityUsd: marketCapUsd * (0.01 + rand() * 0.04),
      volume24hUsd: marketCapUsd * (0.02 + rand() * 0.2),
      holders: Math.floor(20_000 + rand() * 900_000),
    };
  }
}
