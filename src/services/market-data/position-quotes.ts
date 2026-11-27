import { AppError } from "../../lib/errors";
import type { TokenDto } from "../../schemas/token";
import type { IndexedMarketDataProvider } from "./indexed.provider";
import type { MarketDataProvider } from "./provider";

export type PositionQuote = (mint: string, seeded: boolean) => Promise<TokenDto | null>;

export async function optionalQuote(load: () => Promise<TokenDto | null>) {
  try {
    return await load();
  } catch (error) {
    if (error instanceof AppError && (error.status === 404 || error.code === "upstream_error")) return null;
    throw error;
  }
}

export function createPositionQuote(
  live: Pick<MarketDataProvider, "getToken">,
  demo: IndexedMarketDataProvider,
): PositionQuote {
  return async (mint, seeded) =>
    seeded
      ? demo.getToken(mint)
      : ((await demo.getIndexedToken(mint, "demo")) ??
        (await demo.getIndexedToken(mint, "solana")) ??
        live.getToken(mint));
}

export function cachePositionQuotes(quote: PositionQuote): PositionQuote {
  const quotes = new Map<string, Promise<TokenDto | null>>();
  return (mint, seeded) => {
    const key = `${seeded ? "demo" : "real"}:${mint}`;
    let cached = quotes.get(key);
    if (!cached) {
      cached = optionalQuote(() => quote(mint, seeded));
      quotes.set(key, cached);
    }
    return cached;
  };
}
