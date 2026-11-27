import type {
  CandleDto,
  IntervalValue,
  PulseDto,
  TokenDto,
  TokenHoldersDto,
  TradeDto,
} from "../../schemas/token";

/**
 * Source of token stats, candles, trades and holders.
 */
export interface MarketDataProvider {
  readonly name: string;
  listTrending(limit: number): Promise<TokenDto[]>;
  getToken(mint: string): Promise<TokenDto | null>;
  getHistoricalPriceUsd(mint: string, minute: number): Promise<number | null>;
  getCandles(mint: string, interval: IntervalValue, limit: number): Promise<CandleDto[]>;
  getRecentTrades(mint: string, limit: number): Promise<TradeDto[]>;
  getHolders(mint: string, limit: number): Promise<TokenHoldersDto>;
  searchTokens?(query: string): Promise<TokenDto[]>;
  listPulse?(limit: number): Promise<PulseDto>;
}

export const INTERVAL_SECONDS: Record<IntervalValue, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
};
