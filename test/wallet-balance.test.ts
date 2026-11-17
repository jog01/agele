import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "../src/lib/logger";
import { USDC_MINT, USDT_MINT } from "../src/services/helius-parser";
import { RpcWalletBalanceProvider } from "../src/services/wallet-balance.provider";

describe("RPC wallet USDC balances", () => {
  it("sums USDT and native SOL independently, retaining other assets on partial failure", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const requests: unknown[] = [];
    let failAll = false;
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { method: string; params: [string, { mint: string }?] };
        requests.push(body);
        if (failAll || (body.params[0] === "partial" && body.params[1]?.mint === USDT_MINT)) {
          return new Response("Unavailable", { status: 503 });
        }
        if (body.method === "getBalance") return Response.json({ result: { value: 2000000000 } });
        return Response.json({
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: {
                        tokenAmount: {
                          amount: body.params[1]?.mint === USDT_MINT ? "3000000" : "1000000",
                          decimals: 6,
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        });
      },
    });
    try {
      const provider = new RpcWalletBalanceProvider(server.url.toString());
      expect(await provider.getBalances(["healthy", "partial", "healthy"])).toEqual({
        usdcBalance: 2,
        usdtBalance: 3,
        solBalance: 4,
      });
      expect(requests).toHaveLength(6);
      expect(requests).toContainEqual(expect.objectContaining({ method: "getBalance", params: ["healthy"] }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await provider.getBalances([])).toEqual({ usdcBalance: 0, usdtBalance: 0, solBalance: 0 });
      expect(requests).toHaveLength(6);
      failAll = true;
      expect(await provider.getBalances(["healthy"])).toEqual({
        usdcBalance: 0,
        usdtBalance: 0,
        solBalance: 0,
      });
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      server.stop(true);
      warn.mockRestore();
    }
  });
  it("retains successful balances when another wallet RPC fails", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { params: string[] };
        if (body.params[0] === "failed") return new Response("Unavailable", { status: 503 });
        return Response.json({
          result: {
            value: [
              {
                account: {
                  data: {
                    parsed: {
                      info: {
                        tokenAmount: { amount: "3000000", decimals: 6 },
                      },
                    },
                  },
                },
              },
            ],
          },
        });
      },
    });
    try {
      const provider = new RpcWalletBalanceProvider(server.url.toString());
      expect(await provider.getUsdcBalance(["healthy", "failed"])).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ address: "failed" });
    } finally {
      server.stop(true);
      warn.mockRestore();
    }
  });
  it("sums parsed token accounts across distinct linked wallets", async () => {
    const requests: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push(await request.json());
        return Response.json({
          result: {
            value: ["1000000", "2500000"].map((amount) => ({
              account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } },
            })),
          },
        });
      },
    });
    try {
      const provider = new RpcWalletBalanceProvider(server.url.toString());
      expect(await provider.getUsdcBalance(["one", "two", "one"])).toBe(7);
      expect(requests).toHaveLength(2);
      expect(requests).toEqual(
        expect.arrayContaining(
          ["one", "two"].map((address) =>
            expect.objectContaining({
              method: "getTokenAccountsByOwner",
              params: [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
            }),
          ),
        ),
      );
      expect(await provider.getUsdcBalance([])).toBe(0);
      expect(requests).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });
  it("logs and returns zero for RPC errors and malformed replies", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    let reply: unknown = { error: { code: -32000, message: "unavailable" } };
    const server = Bun.serve({ port: 0, fetch: () => Response.json(reply) });
    try {
      const provider = new RpcWalletBalanceProvider(server.url.toString());
      expect(await provider.getUsdcBalance(["wallet"])).toBe(0);
      reply = { result: { value: [] } };
      expect(await provider.getUsdcBalance(["wallet"])).toBe(0);
      reply = { result: { value: [{}] } };
      expect(await provider.getUsdcBalance(["wallet"])).toBe(0);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      server.stop(true);
      warn.mockRestore();
    }
  });
});
