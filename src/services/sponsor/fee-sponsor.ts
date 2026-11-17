/**
 * Seam for gasless transactions (owned by security work). The only component
 * allowed to touch the fee-payer key. It must refuse to sign anything the
 * backend did not build itself; see docs/ARCHITECTURE.md §Gasless for the
 * validation checklist (program allowlist, fee payer only as payer, lamport
 * caps, no durable nonces, simulation, per-user quotas).
 */
export interface FeeSponsor {
  readonly feePayer: string;
  /** Validates and co-signs a backend-built, user-signed transaction. Returns base64. */
  cosign(transactionBase64: string, context: { userId: string; requestId: string }): Promise<string>;
}
