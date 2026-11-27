import { AppError, notFound } from "../lib/errors";
import type { IntervalValue } from "../schemas/token";
import type { MarketDataProvider } from "./market-data";

export class TokenService {
  constructor(private readonly market: MarketDataProvider) {}

  listTrending(limit: number) {
    return this.market.listTrending(limit);
  }

  searchTokens(query: string) {
    if (!this.market.searchTokens) throw new AppError(503, "service_unavailable", "Token search unavailable");
    return this.market.searchTokens(query);
  }

  async searchTokensWithStatus(query: string) {
    if (this.market.searchTokensWithStatus) return this.market.searchTokensWithStatus(query);
    return { tokens: await this.searchTokens(query), tokensUnavailable: false };
  }

  listPulse(limit: number) {
    if (!this.market.listPulse) throw new AppError(503, "service_unavailable", "Pulse unavailable");
    return this.market.listPulse(limit);
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

  async getHolders(mint: string, limit: number) {
    await this.getToken(mint);
    return this.market.getHolders(mint, limit);
  }
}
