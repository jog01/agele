import { AppError } from "../../lib/errors";
import type { TokenDto } from "../../schemas/token";
import type { IndexedMarketDataProvider } from "./indexed.provider";
import type { LiveMarketDataProvider } from "./live.provider";

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
  live: Pick<LiveMarketDataProvider, "getToken">,
  demo: IndexedMarketDataProvider,
): PositionQuote {
  return async (mint, seeded) => {
    if (seeded) return demo.getToken(mint);
    const simulated = await demo.getIndexedToken(mint);
    if (simulated) return simulated;
    const indexed = await demo.getIndexedSolanaQuote(mint);
    if (!indexed) return live.getToken(mint);
    if (indexed.fresh) return indexed.token;
    const current = await optionalQuote(() => live.getToken(mint, indexed.token));
    return current && Number.isFinite(current.priceUsd) && current.priceUsd > 0 ? current : indexed.token;
  };
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
