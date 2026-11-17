import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "../src/lib/logger";
import { USDC_MINT } from "../src/services/helius-parser";
import { RpcWalletBalanceProvider } from "../src/services/wallet-balance.provider";

describe("RPC wallet USDC balances", () => {
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
