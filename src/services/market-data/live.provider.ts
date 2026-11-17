import { z } from "zod";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { tracer } from "../../lib/telemetry";
import type { IntervalValue, TokenDto } from "../../schemas/token";
import { INTERVAL_SECONDS, type MarketDataProvider } from "./provider";

const number = z.number().finite();
const metadata = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    symbol: z.string(),
    decimals: number.int(),
    icon: z.string().nullish(),
    usdPrice: number.nullish(),
    mcap: number.nullish(),
    liquidity: number.nullish(),
    holderCount: number.int().nullish(),
    stats24h: z
      .object({ priceChange: number.nullish(), buyVolume: number.nullish(), sellVolume: number.nullish() })
      .nullish(),
  }),
);
const prices = z.record(z.string(), z.object({ usdPrice: number, priceChange24h: number.nullish() }));
const candles = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(
      z.object({
        unix_time: number.int(),
        o: number,
        h: number,
        l: number,
        c: number,
        v: number,
      }),
    ),
  }),
});
const leg = z.object({ address: z.string(), ui_amount: number, price: number.nullish() });
const trades = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(
      z.object({
        tx_hash: z.string(),
        block_unix_time: number.int(),
        owner: z.string(),
        volume_usd: number,
        from: leg,
        to: leg,
      }),
    ),
  }),
});
const types: Record<IntervalValue, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

interface Options {
  allowlist: string[];
  jupiterApiKey?: string;
  birdeyeApiKey?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export class LiveMarketDataProvider implements MarketDataProvider {
  readonly name = "live";
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly now: () => number;
  private readonly mints: string[];

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.mints = [...new Set(options.allowlist)];
  }

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value as Promise<T>;
    const entry = { expires: Number.POSITIVE_INFINITY, value: Promise.resolve().then(load) };
    this.cache.set(key, entry);
    void entry.value.then(
      () => {
        entry.expires = this.now() + ttl;
      },
      () => {
        this.cache.delete(key);
      },
    );
    return entry.value;
  }

  private async request<T>(
    base: string,
    path: string,
    params: Record<string, string>,
    headers: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const span = tracer.startSpan("market-data.fetch", {
      attributes: { "server.address": new URL(base).host, "url.path": path },
    });
    try {
      const response = await (this.options.fetch ?? fetch)(`${base}${path}?${new URLSearchParams(params)}`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        logger.error(
          { upstream: base, path, status: response.status, statusText: response.statusText },
          "Market data upstream rejected request",
        );
        throw new Error("Non-ok upstream response");
      }
      return schema.parse(await response.json());
    } catch {
      // Do not log exception messages: upstream errors can contain request credentials.
      logger.error({ upstream: base, path }, "Market data upstream failed or returned invalid data");
      throw new AppError(502, "upstream_error", "Market data upstream unavailable");
    } finally {
      span.end();
    }
  }

  private jupiter<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>) {
    const key = this.options.jupiterApiKey;
    return this.request(
      key ? "https://api.jup.ag" : "https://lite-api.jup.ag",
      path,
      params,
      key ? { "x-api-key": key } : {},
      schema,
    );
  }

  private tokens() {
    return this.cached("tokens", 5000, async () => {
      if (!this.mints.length) return [];
      const meta = await this.cached("metadata", 15000, async () => {
        const tokens: z.infer<typeof metadata> = [];
        for (let i = 0; i < this.mints.length; i += 100) {
          tokens.push(
            ...(await this.jupiter(
              "/tokens/v2/search",
              { query: this.mints.slice(i, i + 100).join(",") },
              metadata,
            )),
          );
        }
        return tokens;
      });
      const allPrices: z.infer<typeof prices> = {};
      for (let i = 0; i < this.mints.length; i += 50) {
        Object.assign(
          allPrices,
          await this.jupiter("/price/v3", { ids: this.mints.slice(i, i + 50).join(",") }, prices),
        );
      }
      return meta
        .filter((t) => this.mints.includes(t.id))
        .map(
          (t): TokenDto => ({
            mint: t.id,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            imageUrl: t.icon ?? null,
            priceUsd: allPrices[t.id]?.usdPrice ?? t.usdPrice ?? 0,
            priceChange24hPct: allPrices[t.id]?.priceChange24h ?? t.stats24h?.priceChange ?? 0,
            marketCapUsd: t.mcap ?? 0,
            liquidityUsd: t.liquidity ?? 0,
            holders: t.holderCount ?? 0,
            volume24hUsd: (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0),
          }),
        );
    });
  }

  async listTrending(limit: number) {
    return [...(await this.tokens())].sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, limit);
  }

  async getToken(mint: string) {
    if (!this.mints.includes(mint)) return null;
    return (await this.tokens()).find((t) => t.mint === mint) ?? null;
  }

  private birdeye<T>(feature: string, path: string, params: Record<string, string>, schema: z.ZodType<T>) {
    if (!this.options.birdeyeApiKey)
      throw new AppError(503, "service_unavailable", `${feature} need BIRDEYE_API_KEY`);
    return this.request(
      "https://public-api.birdeye.so",
      path,
      params,
      { "X-API-KEY": this.options.birdeyeApiKey, "x-chain": "solana" },
      schema,
    );
  }

  async getCandles(mint: string, interval: IntervalValue, limit: number) {
    return this.cached(`candles:${mint}:${interval}:${limit}`, 30000, async () => {
      const end = Math.floor(this.now() / 1000);
      const result = await this.birdeye(
        "Candles",
        "/defi/v3/ohlcv",
        {
          address: mint,
          type: types[interval],
          currency: "usd",
          mode: "range",
          time_from: String(end - limit * INTERVAL_SECONDS[interval]),
          time_to: String(end),
        },
        candles,
      );
      return result.data.items
        .map((c) => ({ time: c.unix_time, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v }))
        .sort((a, b) => a.time - b.time)
        .slice(-limit);
    });
  }

  async getRecentTrades(mint: string, limit: number) {
    return this.cached(`trades:${mint}:${limit}`, 5000, async () => {
      const result = await this.birdeye(
        "Trades",
        "/defi/v3/token/txs",
        {
          address: mint,
          tx_type: "swap",
          sort_by: "block_unix_time",
          sort_type: "desc",
          limit: String(limit),
          offset: "0",
        },
        trades,
      );
      return result.data.items
        .filter((t) => t.from.address === mint || t.to.address === mint)
        .map((t) => {
          const buying = t.to.address === mint;
          const token = buying ? t.to : t.from;
          const tokenAmount = Math.abs(token.ui_amount);
          return {
            signature: t.tx_hash,
            mint,
            side: buying ? ("buy" as const) : ("sell" as const),
            trader: t.owner,
            tokenAmount,
            amountUsd: t.volume_usd,
            priceUsd: token.price ?? (tokenAmount ? t.volume_usd / tokenAmount : 0),
            time: t.block_unix_time,
          };
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, limit);
    });
  }
}
