import { z } from "@hono/zod-openapi";
import { rawDecimal } from "../lib/decimal";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Lz7jPeHBTyw2a";
const quotes = [USDC_MINT, USDT_MINT, SOL_MINT];

export const EnhancedTransactionSchema = z
  .object({
    signature: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    feePayer: z.string(),
    fee: z.number().int().nonnegative(),
    transactionError: z.unknown().optional(),
    accountData: z.array(
      z
        .object({
          account: z.string(),
          nativeBalanceChange: z.number().int().default(0),
          tokenBalanceChanges: z
            .array(
              z
                .object({
                  userAccount: z.string(),
                  mint: z.string(),
                  rawTokenAmount: z
                    .object({
                      tokenAmount: z.string().regex(/^-?\d+$/),
                      decimals: z.number().int().min(0).max(255),
                    })
                    .passthrough(),
                })
                .passthrough(),
            )
            .default([]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type EnhancedTransaction = z.infer<typeof EnhancedTransactionSchema>;
export interface ParsedTrade {
  wallet: string;
  signature: string;
  timestamp: number;
  mint: string;
  decimals: number;
  side: "buy" | "sell";
  amount: bigint;
  quoteMint: string;
  quoteAmount: bigint;
}

/** Ignores legs below 0.000000001 units; amounts use 18 fixed decimal places. */
export function parseTrades(tx: EnhancedTransaction, linkedWallets: ReadonlySet<string>): ParsedTrade[] {
  if (tx.transactionError != null) return [];
  const result: ParsedTrade[] = [];
  for (const wallet of linkedWallets) {
    const deltas = new Map<string, bigint>();
    const decimals = new Map<string, number>();
    const add = (mint: string, amount: bigint) => deltas.set(mint, (deltas.get(mint) ?? 0n) + amount);
    for (const account of tx.accountData) {
      if (account.account === wallet) {
        add(
          SOL_MINT,
          rawDecimal(String(account.nativeBalanceChange + (wallet === tx.feePayer ? tx.fee : 0)), 9),
        );
      }
      for (const change of account.tokenBalanceChanges) {
        if (change.userAccount !== wallet) continue;
        add(change.mint, rawDecimal(change.rawTokenAmount.tokenAmount, change.rawTokenAmount.decimals));
        decimals.set(change.mint, change.rawTokenAmount.decimals);
      }
    }
    for (const [mint, amount] of deltas) {
      if (amount > -1_000_000_000n && amount < 1_000_000_000n) deltas.delete(mint);
    }
    const tokens = [...deltas].filter(([mint]) => !quotes.includes(mint));
    if (tokens.length !== 1) continue;
    const [mint, delta] = tokens[0]!;
    const quoteMint = quotes.find((quote) => {
      const amount = deltas.get(quote);
      return amount !== undefined && amount * delta < 0n;
    });
    if (!quoteMint) continue;
    const quote = deltas.get(quoteMint)!;
    result.push({
      wallet,
      signature: tx.signature,
      timestamp: tx.timestamp,
      mint,
      decimals: decimals.get(mint)!,
      side: delta > 0n ? "buy" : "sell",
      amount: delta > 0n ? delta : -delta,
      quoteMint,
      quoteAmount: quote > 0n ? quote : -quote,
    });
  }
  return result;
}
