import { z } from "zod";
import { env } from "../config/env";
import { decimal, formatDecimal, rawDecimal } from "../lib/decimal";
import { logger } from "../lib/logger";
import { USDC_MINT } from "./helius-parser";

export interface WalletBalanceProvider {
  getUsdcBalance(addresses: string[]): Promise<number>;
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

  async getUsdcBalance(addresses: string[]) {
    try {
      const amounts = await Promise.all(
        [...new Set(addresses)].map(async (address) => {
          const response = await this.request(this.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getTokenAccountsByOwner",
              params: [address, { mint: USDC_MINT }, { encoding: "jsonParsed" }],
            }),
          });
          if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
          const body = responseSchema.parse(await response.json());
          return body.result.value.reduce((total, item) => {
            const amount = item.account.data.parsed.info.tokenAmount;
            return total + rawDecimal(amount.amount, amount.decimals);
          }, decimal("0"));
        }),
      );
      return Number(formatDecimal(amounts.reduce((total, amount) => total + amount, 0n)));
    } catch (err) {
      logger.warn({ err }, "USDC balance lookup failed");
      return 0;
    }
  }
}
