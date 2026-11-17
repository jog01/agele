import { describe, expect, it } from "bun:test";
import { decimal } from "../src/lib/decimal";
import { EnhancedTransactionSchema, parseTrades, SOL_MINT, USDC_MINT } from "../src/services/helius-parser";
import { buy, failed, MINT, sell, transfer, usdtBuy, WALLET } from "./fixtures/helius";

describe("Helius enhanced transaction parser", () => {
  const linked = new Set([WALLET]);
  it("parses canonical USDT-quoted buys", () => {
    expect(parseTrades(usdtBuy, linked)).toMatchObject([
      {
        mint: MINT,
        side: "buy",
        amount: decimal("10"),
        quoteMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        quoteAmount: decimal("100"),
      },
    ]);
  });
  it("parses a USDC buy and preserves unknown enhanced fields", () => {
    expect(parseTrades(EnhancedTransactionSchema.parse(buy), linked)).toEqual([
      {
        wallet: WALLET,
        signature: buy.signature,
        timestamp: buy.timestamp,
        mint: MINT,
        decimals: 6,
        side: "buy",
        amount: decimal("10"),
        quoteMint: USDC_MINT,
        quoteAmount: decimal("100"),
      },
    ]);
  });
  it("adds back the fee and merges native SOL with wrapped SOL on sells", () => {
    expect(parseTrades(sell, linked)[0]).toMatchObject({
      side: "sell",
      amount: decimal("4"),
      quoteMint: SOL_MINT,
      quoteAmount: decimal("0.6"),
    });
  });
  it("skips transfers, failed transactions, and unlinked wallets", () => {
    expect(parseTrades(transfer, linked)).toEqual([]);
    expect(parseTrades(failed, linked)).toEqual([]);
    expect(parseTrades(buy, new Set())).toEqual([]);
    expect(parseTrades({ ...buy, accountData: [] }, linked)).toEqual([]);
  });
  it("prefers stablecoin quotes over SOL and ignores dust", () => {
    const tx = structuredClone(buy);
    tx.accountData[0]!.nativeBalanceChange = -1000005000;
    tx.accountData[1]!.tokenBalanceChanges.push({
      userAccount: WALLET,
      mint: "dust",
      rawTokenAmount: { tokenAmount: "1", decimals: 12 },
    });
    expect(parseTrades(tx, linked)[0]!.quoteMint).toBe(USDC_MINT);
  });
  it("rejects malformed raw token quantities", () => {
    const tx = structuredClone(buy);
    tx.accountData[1]!.tokenBalanceChanges[0]!.rawTokenAmount.tokenAmount = "NaN";
    expect(EnhancedTransactionSchema.safeParse(tx).success).toBe(false);
  });
});
