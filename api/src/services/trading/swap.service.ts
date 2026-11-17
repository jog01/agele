/**
 * Seam for the swap flow (owned by onchain feature work). Planned shape, per
 * docs/ARCHITECTURE.md §Trading: quote -> build (Jupiter Swap V2 /order with
 * taker=user, payer=fee payer) -> client signs with Privy -> submit (validate,
 * co-sign via FeeSponsor, Jupiter /execute) -> record trade.
 */
export interface SwapQuoteRequest {
  userWallet: string;
  inputMint: string;
  outputMint: string;
  /** Raw integer amount of inputMint (base units). */
  amount: bigint;
  slippageBps?: number;
}

export interface BuiltSwap {
  requestId: string;
  /** Base64 unsigned (or fee-payer-unsigned) transaction for the user to sign. */
  transaction: string;
  expiresAt: number;
}

export interface SwapService {
  quote(req: Omit<SwapQuoteRequest, "userWallet">): Promise<{ outAmount: bigint; priceImpactPct: number }>;
  build(req: SwapQuoteRequest): Promise<BuiltSwap>;
  submit(requestId: string, userSignedTransaction: string): Promise<{ signature: string }>;
}
