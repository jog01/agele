import type { EnhancedTransaction } from "../../src/services/helius-parser";
import { SOL_MINT, USDC_MINT } from "../../src/services/helius-parser";

export const WALLET = "9xQeWvG816bUx9EPfEZB9f1GjDYWQnbF1gMxU7T5WjCd";
export const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6a5Y8B1pPB263";

export const buy: EnhancedTransaction = {
  signature: "5KtEnhancedUsdcBuyFixture",
  timestamp: 1767268800,
  feePayer: WALLET,
  fee: 5000,
  transactionError: null,
  type: "SWAP",
  source: "JUPITER",
  accountData: [
    { account: WALLET, nativeBalanceChange: -5000, tokenBalanceChanges: [] },
    {
      account: "TokenAccount",
      nativeBalanceChange: 0,
      tokenBalanceChanges: [
        { userAccount: WALLET, mint: MINT, rawTokenAmount: { tokenAmount: "10000000", decimals: 6 } },
        { userAccount: WALLET, mint: USDC_MINT, rawTokenAmount: { tokenAmount: "-100000000", decimals: 6 } },
      ],
    },
  ],
};

export const sell: EnhancedTransaction = {
  ...buy,
  signature: "3NsEnhancedSolSellFixture",
  timestamp: buy.timestamp + 60,
  accountData: [
    {
      account: WALLET,
      nativeBalanceChange: 399995000,
      tokenBalanceChanges: [
        { userAccount: WALLET, mint: SOL_MINT, rawTokenAmount: { tokenAmount: "200000000", decimals: 9 } },
      ],
    },
    {
      account: "TokenAccount",
      nativeBalanceChange: 0,
      tokenBalanceChanges: [
        { userAccount: WALLET, mint: MINT, rawTokenAmount: { tokenAmount: "-4000000", decimals: 6 } },
      ],
    },
  ],
};

export const transfer: EnhancedTransaction = {
  ...buy,
  signature: "TransferFixture",
  type: "TRANSFER",
  accountData: [
    buy.accountData[0]!,
    { ...buy.accountData[1]!, tokenBalanceChanges: [buy.accountData[1]!.tokenBalanceChanges[0]!] },
  ],
};
export const failed: EnhancedTransaction = {
  ...buy,
  signature: "FailedFixture",
  transactionError: { error: "InstructionError" },
};

export const rentRefundTransfer: EnhancedTransaction = {
  ...transfer,
  signature: "TransferWithClosedTokenAccountFixture",
  accountData: [
    { account: WALLET, nativeBalanceChange: 2039280 - 5000, tokenBalanceChanges: [] },
    {
      account: "ClosedTokenAccount",
      nativeBalanceChange: -2039280,
      tokenBalanceChanges: [
        { userAccount: WALLET, mint: MINT, rawTokenAmount: { tokenAmount: "-10000000", decimals: 6 } },
      ],
    },
  ],
};

export const usdtBuy: EnhancedTransaction = {
  ...buy,
  signature: "EnhancedUsdtBuyFixture",
  accountData: buy.accountData.map((account) => ({
    ...account,
    tokenBalanceChanges: account.tokenBalanceChanges.map((change) => ({
      ...change,
      mint: change.mint === USDC_MINT ? "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" : change.mint,
    })),
  })),
};
