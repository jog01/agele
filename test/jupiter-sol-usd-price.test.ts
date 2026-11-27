import { describe, expect, it } from "bun:test";
import { JupiterSolUsdPrice } from "../src/services/chain-ingest/jupiter-sol-usd-price";
import { SOL_MINT } from "../src/services/helius-parser";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import fixture from "./fixtures/jupiter-prices.json";

describe("JupiterSolUsdPrice", () => {
  it.each([
    ["lite-api.jup.ag", undefined, {}],
    ["api.jup.ag", "test-key", { "x-api-key": "test-key" }],
  ])("loads and caches the wSOL quote from %s", async (host, jupiterApiKey, headers) => {
    let now = 1_800_000_000_000;
    const calls: { url: URL; headers?: RequestInit["headers"] }[] = [];
    const quote = new JupiterSolUsdPrice(
      new LiveMarketDataProvider({
        jupiterApiKey,
        now: () => now,
        fetch: async (url, init) => {
          calls.push({ url: new URL(url), headers: init?.headers });
          return Response.json(fixture);
        },
      }),
    );
    const expected = fixture[SOL_MINT].usdPrice;
    expect(await Promise.all([quote.getSolUsd(12), quote.getSolUsd(13)])).toEqual([expected, expected]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe(`https://${host}/price/v3?ids=${SOL_MINT}`);
    expect(calls[0]?.headers).toEqual(headers);
    now += 4999;
    expect(await quote.getSolUsd(20)).toBe(expected);
    expect(calls).toHaveLength(1);
    now++;
    expect(await quote.getSolUsd(21)).toBe(expected);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["missing", {}],
    ["zero", { [SOL_MINT]: { usdPrice: 0 } }],
    ["negative", { [SOL_MINT]: { usdPrice: -1 } }],
    ["nonfinite", { [SOL_MINT]: { usdPrice: Number.NaN } }],
  ])("rejects a %s wSOL quote", async (_description, prices) => {
    const quote = new JupiterSolUsdPrice(
      new LiveMarketDataProvider({ fetch: async () => Response.json(prices) }),
    );
    await expect(quote.getSolUsd(0)).rejects.toMatchObject({ status: 502, code: "upstream_error" });
  });
});
