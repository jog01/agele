import { AppError } from "../../lib/errors";
import { SOL_MINT } from "../helius-parser";
import type { LiveMarketDataProvider } from "../market-data/live.provider";
import type { SolUsdPrice } from "./chain-facts";

export class JupiterSolUsdPrice implements SolUsdPrice {
  constructor(private readonly prices: Pick<LiveMarketDataProvider, "getUsdPrice">) {}

  async getSolUsd(_time: number) {
    const price = await this.prices.getUsdPrice(SOL_MINT);
    if (price === undefined || !Number.isFinite(price) || price <= 0) {
      throw new AppError(502, "upstream_error", "SOL price unavailable");
    }
    return price;
  }
}
