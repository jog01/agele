import { z } from "zod";
import { env } from "../config/env";
import { decimal, formatDecimal, rawDecimal } from "../lib/decimal";
import { logger } from "../lib/logger";
import { USDC_MINT, USDT_MINT } from "./helius-parser";

export interface WalletBalanceProvider {
  getBalances(addresses: string[]): Promise<{ usdcBalance: number; usdtBalance: number; solBalance: number }>;
}

const responseSchema = z.object({
  result: z.object({
    value: z.array(
      z.object({
        account: z.object({
          data: z.object({
            parsed: z.object({
              info: z.object({
                tokenAmount: z.object({
                  amount: z.string().regex(/^\d+$/),
                  decimals: z.number().int().min(0).max(255),
                }),
              }),
            }),
          }),
        }),
      }),
    ),
  }),
});

export class RpcWalletBalanceProvider implements WalletBalanceProvider {
  constructor(
    private readonly url = env.SOLANA_RPC_URL,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async rpc(method: string, params: unknown[]) {
    const response = await this.request(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    return response.json();
  }

  private async sum(addresses: string[], asset: string, lookup: (address: string) => Promise<bigint>) {
    const wallets = [...new Set(addresses)];
    const amounts = await Promise.allSettled(wallets.map(lookup));
    return Number(
      formatDecimal(
        amounts.reduce((total, result, index) => {
          if (result.status === "fulfilled") return total + result.value;
          logger.warn({ err: result.reason, address: wallets[index], asset }, "Wallet balance lookup failed");
          return total;
        }, 0n),
      ),
    );
  }

  private getTokenBalance(addresses: string[], mint: string) {
    return this.sum(addresses, mint, async (address) => {
      const body = responseSchema.parse(
        await this.rpc("getTokenAccountsByOwner", [address, { mint }, { encoding: "jsonParsed" }]),
      );
      return body.result.value.reduce((total, item) => {
        const amount = item.account.data.parsed.info.tokenAmount;
        return total + rawDecimal(amount.amount, amount.decimals);
      }, decimal("0"));
    });
  }

  getUsdcBalance(addresses: string[]) {
    return this.getTokenBalance(addresses, USDC_MINT);
  }

  async getBalances(addresses: string[]) {
    const [usdcBalance, usdtBalance, solBalance] = await Promise.all([
      this.getUsdcBalance(addresses),
      this.getTokenBalance(addresses, USDT_MINT),
      this.sum(addresses, "SOL", async (address) => {
        const body = z
          .object({ result: z.object({ value: z.number().int().nonnegative() }) })
          .parse(await this.rpc("getBalance", [address]));
        return rawDecimal(String(body.result.value), 9);
      }),
    ]);
    return { usdcBalance, usdtBalance, solBalance };
  }
}
