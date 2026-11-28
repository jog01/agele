import { describe, expect, it } from "bun:test";
import { TokenHoldersSchema } from "../src/schemas/token";
import { LiveMarketDataProvider } from "../src/services/market-data/live.provider";
import { MockMarketDataProvider } from "../src/services/market-data/mock.provider";
import { TokenService } from "../src/services/token.service";
import prices from "./fixtures/jupiter-prices.json";
import metadata from "./fixtures/jupiter-tokens.json";
import {
  largest,
  nativeSupply,
  owners,
  RAYDIUM_AUTHORITY,
  supply,
  wrappedSolLargest,
} from "./fixtures/token-holders";
import { FIXED_NOW, SOL, testApp } from "./helpers";

const mint = metadata[0]!.id;
type Options = ConstructorParameters<typeof LiveMarketDataProvider>[0];
function setup(overrides: Partial<Options> = {}, rpcResult?: (method: string) => Response) {
  let now = FIXED_NOW;
  const calls: { url: string; init?: RequestInit; method?: string; params?: unknown[] }[] = [];
  const market = new LiveMarketDataProvider({
    solanaRpcUrl: "https://rpc.example.test",
    now: () => now,
    fetch: async (url, init) => {
      if (init?.method !== "POST") {
        calls.push({ url, init });
        return Response.json(url.includes("search") ? metadata : prices);
      }
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      calls.push({ url, init, method, params });
      if (rpcResult) return rpcResult(method);
      return Response.json(
        method === "getTokenLargestAccounts" ? largest : method === "getTokenSupply" ? supply : owners,
      );
    },
    ...overrides,
  });
  return {
    market,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("token holders", () => {
  it("uses native SOL total supply and 9 decimals for wrapped SOL concentration", async () => {
    const { market, calls } = setup({}, (method) =>
      Response.json(
        method === "getSupply"
          ? nativeSupply
          : method === "getTokenLargestAccounts"
            ? wrappedSolLargest
            : method === "getTokenSupply"
              ? { result: { value: { amount: "0", decimals: 9 } } }
              : owners,
      ),
    );
    const result = await market.getHolders(SOL, 5);
    expect(result.holders[0]!.amount).toBe(39_000_000);
    expect(result.holders[0]!.pctSupply).toBeCloseTo(6.5);
    expect(result.top10Pct).toBeCloseTo(27.5);
    expect(result.holders[0]!.valueUsd).toBe(39_000_000 * prices[SOL]!.usdPrice);
    expect(calls.filter((c) => c.method === "getSupply")).toHaveLength(1);
    expect(calls.some((c) => c.method === "getTokenSupply")).toBe(false);
  });

  it("maps a native SOL supply RPC error to 502", async () => {
    const { market } = setup({}, (method) =>
      Response.json(
        method === "getSupply" ? { error: { code: -32005, message: "unhealthy" } } : wrappedSolLargest,
      ),
    );
    await expect(market.getHolders(SOL, 5)).rejects.toMatchObject({ status: 502, code: "upstream_error" });
  });
  it("merges owners before ranking, computes percentages/value, labels known pools, and limits after top10", async () => {
    const { market, calls } = setup();
    const result = TokenHoldersSchema.parse(await market.getHolders(mint, 5));
    expect(result.holders).toHaveLength(5);
    expect(result.holders[0]).toEqual({
      rank: 1,
      wallet: "merged-wallet",
      amount: 39,
      pctSupply: 3.9,
      valueUsd: 39 * prices[mint as keyof typeof prices]!.usdPrice,
      isPool: false,
    });
    expect(result.holders[1]).toMatchObject({
      wallet: RAYDIUM_AUTHORITY,
      isPool: true,
      label: "Raydium",
      amount: 18,
    });
    expect(result.holders[2]).not.toHaveProperty("label");
    expect(result.totalHolders).toBe(metadata[0]!.holderCount);
    expect(result.top10Pct).toBeCloseTo(16.5);
    expect(result.updatedAt).toBe(FIXED_NOW / 1000);
    const rpcCalls = calls.filter((c) => c.method);
    expect(rpcCalls.map((c) => c.method)).toEqual([
      "getTokenLargestAccounts",
      "getTokenSupply",
      "getMultipleAccounts",
    ]);
    expect(rpcCalls[2]!.params).toEqual([
      largest.result.value.map((a) => a.address),
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    expect(
      rpcCalls.every((c) => c.url === "https://rpc.example.test" && c.init?.signal instanceof AbortSignal),
    ).toBe(true);
  });

  it("shares the 60s cache and in-flight request across different limits", async () => {
    const { market, calls, advance } = setup();
    const [one, all] = await Promise.all([market.getHolders(mint, 1), market.getHolders(mint, 20)]);
    expect(one.holders).toHaveLength(1);
    expect(all.holders).toHaveLength(19);
    expect(one.top10Pct).toBe(all.top10Pct);
    expect(calls.filter((c) => c.method)).toHaveLength(3);
    advance(59999);
    expect((await market.getHolders(mint, 5)).updatedAt).toBe(FIXED_NOW / 1000);
    expect(calls.filter((c) => c.method)).toHaveLength(3);
    advance(1);
    expect((await market.getHolders(mint, 5)).updatedAt).toBe(FIXED_NOW / 1000 + 60);
    expect(calls.filter((c) => c.method)).toHaveLength(6);
  });

  it("prefers Helius when a key is configured", async () => {
    const { market, calls } = setup({ heliusApiKey: "test-key" });
    await market.getHolders(mint, 1);
    expect(
      calls
        .filter((c) => c.method)
        .every((c) => c.url === "https://mainnet.helius-rpc.com/?api-key=test-key"),
    ).toBe(true);
  });

  it("returns empty holders without an unnecessary owner request", async () => {
    const { market, calls } = setup({}, (method) =>
      Response.json(method === "getTokenSupply" ? supply : { result: { value: [] } }),
    );
    expect(await market.getHolders(mint, 20)).toMatchObject({ holders: [], top10Pct: 0 });
    expect(calls.filter((c) => c.method)).toHaveLength(2);
  });

  it("handles zero supply and accounts closed between RPC calls", async () => {
    const { market } = setup({}, (method) =>
      Response.json(
        method === "getTokenSupply"
          ? { result: { value: { amount: "0", decimals: 2 } } }
          : method === "getMultipleAccounts"
            ? { result: { value: owners.result.value.map((v, i) => (i === 0 ? null : v)) } }
            : largest,
      ),
    );
    const result = await market.getHolders(mint, 20);
    expect(result.top10Pct).toBe(0);
    expect(result.holders.find((h) => h.wallet === "merged-wallet")?.amount).toBe(19);
    expect(result.holders.every((h) => h.pctSupply === 0)).toBe(true);
  });

  it("rejects unresolved mints with 404 without RPC calls", async () => {
    const { market, calls } = setup();
    const app = testApp({ market, tokens: new TokenService(market) });
    const unknownMint = "11111111111111111111111111111111";
    const response = await app.request(`/v1/tokens/${unknownMint}/holders`);
    expect(response.status).toBe(404);
    await expect(market.getHolders(unknownMint, 5)).rejects.toMatchObject({ status: 404 });
    expect(calls.map((call) => call.method)).toEqual([undefined]);
    const unresolved = setup({
      fetch: async (url) => Response.json(url.includes("search") ? [] : {}),
    });
    await expect(unresolved.market.getHolders(SOL, 5)).rejects.toMatchObject({ status: 404 });
  });

  for (const [name, result] of Object.entries({
    http: () => new Response("rate limited", { status: 429 }),
    rpc: () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "unhealthy" } }),
    malformed: () => Response.json({ result: { value: "bad" } }),
    timeout: () => {
      throw new DOMException("timeout", "TimeoutError");
    },
    mismatch: (method: string) =>
      Response.json(
        method === "getMultipleAccounts"
          ? { result: { value: [] } }
          : method === "getTokenSupply"
            ? supply
            : largest,
      ),
  })) {
    it(`turns ${name} upstream failure into 502 and allows retry`, async () => {
      const { market, calls } = setup({}, result);
      const app = testApp({ market, tokens: new TokenService(market) });
      const response = await app.request(`/v1/tokens/${mint}/holders?limit=5`);
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: "upstream_error" } });
      await expect(market.getHolders(mint, 5)).rejects.toMatchObject({ status: 502 });
      expect(calls.filter((c) => c.method === "getTokenLargestAccounts")).toHaveLength(2);
    });
  }

  it("serves deterministic mock holders and validates/defaults limit", async () => {
    const market = new MockMarketDataProvider(() => FIXED_NOW);
    expect(await market.getHolders(SOL, 5)).toEqual(await market.getHolders(SOL, 5));
    const app = testApp();
    const response = await app.request(`/v1/tokens/${SOL}/holders`);
    expect(response.status).toBe(200);
    const body = TokenHoldersSchema.parse(await response.json());
    expect(body.holders).toHaveLength(20);
    expect(body.updatedAt).toBe(FIXED_NOW / 1000);
    expect(body.top10Pct).toBeGreaterThan(body.holders[0]!.pctSupply);
    for (const limit of ["0", "51", "1.5", "x"]) {
      expect((await app.request(`/v1/tokens/${SOL}/holders?limit=${limit}`)).status).toBe(400);
    }
    const limited = await app.request(`/v1/tokens/${SOL}/holders?limit=1`);
    expect(TokenHoldersSchema.parse(await limited.json()).holders).toHaveLength(1);
    expect((await app.request("/v1/tokens/11111111111111111111111111111111/holders")).status).toBe(404);
  });
});
