import { AppError } from "../../lib/errors";

/**
 * Seam for gasless transactions (owned by security work). The only component
 * allowed to touch the fee-payer key. It must refuse to sign anything the
 * backend did not build itself. Rules: docs/fee-payer-security-policy.md.
 */
export type SponsorKind = "swap" | "withdraw";

export interface SponsorRegisterContext {
  userId: string;
  wallet: string;
  kind: SponsorKind;
  requestId: string;
  swap?: {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    otherAmountThreshold: string;
    router: string;
    lastValidBlockHeight?: string;
    feeBps?: number;
    referralAccount?: string;
  };
}

export interface FeeSponsor {
  readonly feePayer: string;
  ready?(): Promise<void>;
  /** Validates a backend-built transaction before the user signs it and stores the issued record (policy §2-§4). */
  register(transactionBase64: string, context: SponsorRegisterContext): Promise<{ expiresAt: number }>;
  /** Re-validates and co-signs a registered, user-signed transaction. Returns base64 for submission only. */
  cosign(transactionBase64: string, context: { userId: string; requestId: string }): Promise<string>;
  reportOutcome?(context: {
    userId: string;
    requestId: string;
    status: "confirmed" | "failed" | "submitted";
    signature?: string;
  }): Promise<void>;
}

export type SponsorRejectReason =
  | "sponsor_disabled"
  | "kill_switch"
  | "malformed"
  | "lookup_table"
  | "program_not_allowed"
  | "fee_payer_role"
  | "instruction_not_allowed"
  | "fee_cap"
  | "signature_cap"
  | "nonce"
  | "blockhash"
  | "simulation"
  | "token_extension"
  | "mint_not_allowed"
  | "quota"
  | "record_missing"
  | "record_expired"
  | "record_used"
  | "message_mismatch";

export class SponsorRejectedError extends AppError {
  constructor(readonly reason: SponsorRejectReason) {
    super(422, "sponsor_rejected", `Transaction not sponsored: ${reason}`);
  }
}
