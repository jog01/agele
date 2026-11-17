import { describe, expect, it } from "bun:test";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { TokenService } from "../src/services/token.service";
import priceFixture from "./fixtures/jupiter-prices.json";
import tokenFixture from "./fixtures/jupiter-tokens.json";
import { testApp } from "./helpers";

const mints = tokenFixture.map((t) => t.id);
const jup = mints[0]!;
const sol = mints[1]!;
function setup(extra: Partial<ConstructorParameters<typeof LiveMarketDataProvider>[0]> = {}) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  let now = 1_800_000_000_000;
  const market = new LiveMarketDataProvider({
    allowlist: mints,
    now: () => now,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      return Response.json(url.pathname.includes("search") ? tokenFixture : priceFixture);
    },
    ...extra,
  });
  return {
    market,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("live market data", () => {
  it("maps real symbols/logos, stats and Price V3; sorts trending and limits", async () => {
    const { market, calls } = setup();
    const token = await market.getToken(jup);
    expect(token).toMatchObject({
      symbol: "JUP",
      imageUrl: tokenFixture[0]!.icon,
      priceUsd: priceFixture[jup as keyof typeof priceFixture]!.usdPrice,
      holders: tokenFixture[0]!.holderCount,
    });
    expect(token?.volume24hUsd).toBe(
      tokenFixture[0]!.stats24h.buyVolume + tokenFixture[0]!.stats24h.sellVolume,
    );
    expect((await market.listTrending(2)).map((t) => t.mint)).toEqual([sol, jup]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.host).toBe("lite-api.jup.ag");
    expect(calls[0]!.url.searchParams.get("query")).toBe(mints.join(","));
  });

  it("dedupes in flight, refreshes prices at 5s and metadata at 15s", async () => {
    const { market, calls, advance } = setup();
    await Promise.all([market.getToken(jup), market.getToken(sol), market.listTrending(3)]);
    expect(calls).toHaveLength(2);
    advance(5000);
    await market.getToken(jup);
    expect(calls).toHaveLength(3);
    advance(10000);
    await market.getToken(jup);
    expect(calls).toHaveLength(5);
  });

  it("returns null/404 for non-allowlisted and unresolved mints, and handles empty lists", async () => {
    const { market, calls } = setup({ allowlist: ["unknown"] });
    expect(await market.getToken(jup)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await market.getToken("unknown")).toBeNull();
    const res = await testApp({ market, tokens: new TokenService(market) }).request(`/v1/tokens/${jup}`);
    expect(res.status).toBe(404);
    const empty = setup({ allowlist: [] });
    expect(await empty.market.listTrending(10)).toEqual([]);
    expect(empty.calls).toHaveLength(0);
  });

  it("batches Price V3 at 50 ids and uses keyed Jupiter host/header", async () => {
    const { market, calls } = setup({
      allowlist: Array.from({ length: 101 }, (_, i) => `mint${i}`),
      jupiterApiKey: "test-key",
    });
    await market.listTrending(5);
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).map((c) => c.url.searchParams.get("ids")!.split(",").length)).toEqual([50, 50, 1]);
    expect(calls[0]!.url.host).toBe("api.jup.ag");
    expect(calls[0]!.init?.headers).toEqual({ "x-api-key": "test-key" });
  });

  it("falls back to metadata prices when Price V3 omits a mint", async () => {
    const { market } = setup({
      fetch: async (url) => Response.json(url.includes("search") ? tokenFixture : {}),
    });
    expect((await market.getToken(jup))?.priceUsd).toBe(tokenFixture[0]!.usdPrice);
  });

  it("keeps a metadata batch usable with null, absent, or partial 24h stats", async () => {
    const sparse = tokenFixture.map(({ stats24h: _stats, ...token }, i) => ({
      ...token,
      ...(i === 0 ? { stats24h: null } : i === 1 ? {} : { stats24h: { buyVolume: null } }),
    }));
    const { market } = setup({ fetch: async (url) => Response.json(url.includes("search") ? sparse : {}) });
    const tokens = await market.listTrending(3);
    expect(tokens).toHaveLength(3);
    for (const token of tokens) {
      expect(token.volume24hUsd).toBe(0);
      expect(token.priceChange24hPct).toBe(0);
      expect(token.priceUsd).toBe(tokenFixture.find((t) => t.id === token.mint)!.usdPrice);
    }
  });

  it("returns 503 for candles and trades without Birdeye credentials", async () => {
    const { market, calls } = setup();
    await expect(market.getCandles(jup, "1m", 2)).rejects.toMatchObject({
      status: 503,
      message: "Candles need BIRDEYE_API_KEY",
    });
    await expect(market.getRecentTrades(jup, 2)).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(0);
  });

  it("maps Birdeye OHLCV oldest first, intervals, boundaries, headers and cache", async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const { market, advance } = setup({
      birdeyeApiKey: "test-key",
      fetch: async (url, init) => {
        calls.push({ url: new URL(url), init });
        return Response.json({
          success: true,
          data: {
            items: [
              { unix_time: 1726671600, o: 2, h: 4, l: 1, c: 3, v: 50 },
              { unix_time: 1726670700, o: 1, h: 3, l: 1, c: 2, v: 40 },
            ],
          },
        });
      },
    });
    expect(await market.getCandles(jup, "1h", 2)).toEqual([
      { time: 1726670700, open: 1, high: 3, low: 1, close: 2, volume: 40 },
      { time: 1726671600, open: 2, high: 4, low: 1, close: 3, volume: 50 },
    ]);
    await market.getCandles(jup, "1h", 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("type")).toBe("1H");
    expect(calls[0]!.url.searchParams.get("time_from")).toBe(String(1_800_000_000 - 7200));
    expect(calls[0]!.init?.headers).toEqual({ "X-API-KEY": "test-key", "x-chain": "solana" });
    advance(30000);
    await market.getCandles(jup, "1h", 2);
    expect(calls).toHaveLength(2);
  });

  it("maps swap token legs and orders trades newest first", async () => {
    const { market } = setup({
      birdeyeApiKey: "key",
      fetch: async () =>
        Response.json({
          success: true,
          data: {
            items: [
              {
                tx_hash: "buy",
                block_unix_time: 1,
                owner: "wallet",
                volume_usd: 20,
                from: { address: sol, ui_amount: 1 },
                to: { address: jup, ui_amount: 10, price: 2 },
              },
              {
                tx_hash: "sell",
                block_unix_time: 2,
                owner: "wallet2",
                volume_usd: 30,
                from: { address: jup, ui_amount: 10 },
                to: { address: sol, ui_amount: 1 },
              },
            ],
          },
        }),
    });
    expect(await market.getRecentTrades(jup, 2)).toEqual([
      {
        signature: "sell",
        mint: jup,
        side: "sell",
        trader: "wallet2",
        tokenAmount: 10,
        amountUsd: 30,
        priceUsd: 3,
        time: 2,
      },
      {
        signature: "buy",
        mint: jup,
        side: "buy",
        trader: "wallet",
        tokenAmount: 10,
        amountUsd: 20,
        priceUsd: 2,
        time: 1,
      },
    ]);
  });

  it("handles empty Birdeye results", async () => {
    const { market } = setup({
      birdeyeApiKey: "key",
      fetch: async () => Response.json({ success: true, data: { items: [] } }),
    });
    expect(await market.getCandles(jup, "1d", 2)).toEqual([]);
    expect(await market.getRecentTrades(jup, 2)).toEqual([]);
  });

  for (const [name, fetcher] of Object.entries({
    http: async () => new Response("rate limited", { status: 429 }),
    timeout: async () => {
      throw new DOMException("timeout", "TimeoutError");
    },
    malformed: async () => Response.json({ invalid: true }),
  })) {
    it(`converts ${name} failures to 502 and allows retries`, async () => {
      let calls = 0;
      const { market } = setup({
        fetch: async () => {
          calls++;
          return fetcher();
        },
      });
      await expect(market.getToken(jup)).rejects.toMatchObject({ status: 502, code: "upstream_error" });
      await expect(market.getToken(jup)).rejects.toMatchObject({ status: 502 });
      expect(calls).toBe(2);
    });
  }
});
