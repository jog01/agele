import { notFound } from "../lib/errors";
import type { IntervalValue } from "../schemas/token";
import type { MarketDataProvider } from "./market-data";

export class TokenService {
  constructor(private readonly market: MarketDataProvider) {}

  listTrending(limit: number) {
    return this.market.listTrending(limit);
  }

  async getToken(mint: string) {
    const token = await this.market.getToken(mint);
    if (!token) throw notFound("Token");
    return token;
  }

  async getCandles(mint: string, interval: IntervalValue, limit: number) {
    await this.getToken(mint);
    return this.market.getCandles(mint, interval, limit);
  }

  async getRecentTrades(mint: string, limit: number) {
    await this.getToken(mint);
    return this.market.getRecentTrades(mint, limit);
  }
}
