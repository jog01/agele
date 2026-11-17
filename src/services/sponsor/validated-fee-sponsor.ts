import { createHash } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import {
  address,
  createKeyPairFromBytes,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Encoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  type ReadonlyUint8Array,
  verifySignature,
} from "@solana/kit";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import type { MarketDataProvider } from "../market-data";
import { type FeeSponsor, type SponsorRegisterContext, SponsorRejectedError } from "./fee-sponsor";
import type { IssuedRecord, SponsorStore } from "./issued-store";
import { PROGRAMS } from "./programs";
import type { SponsorRpc } from "./sponsor-rpc";
import { SWAP_MINTS_V01 } from "./swap-mints";
import {
  decodeTransaction,
  refuse,
  type SponsorValidation,
  SponsorValidator,
  tokenAccount,
} from "./validator";

const counter = metrics.getMeter("fee-sponsor").createCounter("sponsor_events");
const hash = (bytes: ReadonlyUint8Array) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");
export interface SponsorOptions {
  enabled: () => boolean;
  feePayer: string;
  secret: string;
  rpc: SponsorRpc;
  store: SponsorStore;
  market: MarketDataProvider;
  maxCuPrice?: bigint;
  maxLamports?: bigint;
  referralAccount?: string;
  referralFeeBps?: number;
  now?: () => number;
}

export class ValidatedFeeSponsor implements FeeSponsor {
  readonly feePayer: string;
  private keyPair?: CryptoKeyPair;
  private initialization?: Promise<void>;
  private secret?: string;
  private readonly validator: SponsorValidator;
  private readonly now: () => number;

  constructor(private readonly options: SponsorOptions) {
    this.feePayer = address(options.feePayer);
    this.secret = options.secret;
    // Do not retain signer material in the general options object.
    options.secret = "";
    this.now = options.now ?? Date.now;
    this.validator = new SponsorValidator(
      options.rpc,
      this.feePayer,
      {
        maxCuPrice: options.maxCuPrice ?? 2_000_000n,
        maxLamports: options.maxLamports ?? 10_000_000n,
      },
      this.now,
    );
  }

  ready() {
    this.initialization ??= this.initialize();
    return this.initialization;
  }
  private async initialize() {
    let bytes: Uint8Array | undefined;
    try {
      const secret = this.secret;
      this.secret = undefined;
      if (!secret) throw new Error();
      if (secret.trim().startsWith("[")) {
        const data: unknown = JSON.parse(secret);
        if (
          !Array.isArray(data) ||
          data.length !== 64 ||
          data.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
        )
          throw new Error();
        bytes = Uint8Array.from(data);
      } else bytes = new Uint8Array(getBase58Encoder().encode(secret.trim()));
      if (bytes.length !== 64) throw new Error();
      const keyPair = await createKeyPairFromBytes(bytes);
      if ((await getAddressFromPublicKey(keyPair.publicKey)) !== this.feePayer) throw new Error();
      this.keyPair = keyPair;
    } catch {
      throw new Error("Fee-payer signer initialization failed");
    } finally {
      bytes?.fill(0);
    }
  }

  private event(event: string, fields: { reason?: string; messageHash?: string; signature?: string } = {}) {
    counter.add(1, { event, ...(fields.reason ? { reason: fields.reason } : {}) });
    logger.info({ event, ...fields }, "fee sponsor");
  }
  private async guard(userId: string) {
    if (!this.options.enabled()) refuse("kill_switch");
    await this.ready();
    await this.options.store.check(userId);
  }
  private async checked<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AppError && error.status === 503) {
        this.event("reject", { reason: "quota" });
        throw error;
      }
      const rejection =
        error instanceof SponsorRejectedError ? error : new SponsorRejectedError("simulation");
      this.event("reject", { reason: rejection.reason });
      throw rejection;
    }
  }

  private async eligibility(context: SponsorRegisterContext, validation: SponsorValidation) {
    const expected = context.swap!;
    const walletTokens = await this.options.rpc.tokenAccounts(context.wallet);
    const usdc = walletTokens.reduce((sum, t) => {
      const token = tokenAccount(t.account);
      return (
        sum + (token?.owner === context.wallet && token.mint === SWAP_MINTS_V01.USDC ? token.amount : 0n)
      );
    }, 0n);
    if (usdc < 5_000_000n) refuse("quota");
    if (this.options.market.name !== "live") refuse("quota");
    const [input, sol] = await Promise.all([
      expected.inputMint === SWAP_MINTS_V01.USDC
        ? Promise.resolve({ decimals: 6, priceUsd: 1 })
        : this.options.market.getToken(expected.inputMint),
      this.options.market.getToken(SWAP_MINTS_V01.SOL),
    ]);
    if (
      !input ||
      !sol ||
      !Number.isFinite(input.priceUsd) ||
      input.priceUsd <= 0 ||
      !Number.isFinite(sol.priceUsd) ||
      sol.priceUsd <= 0
    )
      return refuse("quota");
    const notional = (Number(BigInt(expected.inAmount)) / 10 ** input.decimals) * input.priceUsd;
    if (!Number.isFinite(notional) || notional < 5) return refuse("quota");
    const fee = this.options.referralFeeBps ?? 0;
    if (this.options.referralAccount === this.feePayer) return refuse("fee_payer_role");
    if (
      !this.options.referralAccount ||
      expected.referralAccount !== this.options.referralAccount ||
      fee < 50 ||
      fee > 255 ||
      (expected.feeBps ?? 0) < fee
    )
      return refuse("quota");
    const costUsd =
      (Number(validation.expectedFeeLamports + validation.expectedRentLamports) / 1e9) * sol.priceUsd;
    if (((notional * fee) / 10_000) * 0.8 < costUsd) refuse("fee_cap");
  }

  private async simulate(encoded: string, context: SponsorRegisterContext, validation: SponsorValidation) {
    const expected = context.swap!;
    const payerTokens = await this.options.rpc.tokenAccounts(this.feePayer);
    if (payerTokens.length) return refuse("fee_payer_role");
    const addresses = [...new Set([...validation.addresses, context.wallet, this.feePayer])];
    if (addresses.length > 100) return refuse("simulation");
    const before = await this.options.rpc.accounts(addresses, "processed");
    const simulated = await this.options.rpc.simulate(encoded, addresses);
    if (simulated.err !== null || simulated.accounts.length !== addresses.length) return refuse("simulation");
    for (const ata of validation.payerFundedAtas)
      if (tokenAccount(simulated.accounts[addresses.indexOf(ata)])?.owner !== context.wallet)
        return refuse("simulation");
    const payerIndex = addresses.indexOf(this.feePayer);
    const prePayer = before[payerIndex],
      postPayer = simulated.accounts[payerIndex];
    if (
      !prePayer ||
      !postPayer ||
      prePayer.owner !== PROGRAMS.system ||
      postPayer.owner !== PROGRAMS.system ||
      prePayer.lamports - postPayer.lamports >
        validation.expectedFeeLamports + validation.expectedRentLamports
    )
      return refuse("simulation");
    const deltas = new Map<string, bigint>();
    let receivedInAta = 0n;
    const [outputMintAccount] = await this.options.rpc.accounts([expected.outputMint]);
    if (!outputMintAccount) return refuse("simulation");
    const [outputAta] = await getProgramDerivedAddress({
      programAddress: address(PROGRAMS.ata),
      seeds: [
        getAddressEncoder().encode(address(context.wallet)),
        getAddressEncoder().encode(address(outputMintAccount.owner)),
        getAddressEncoder().encode(address(expected.outputMint)),
      ],
    });
    for (let i = 0; i < addresses.length; i++) {
      const old = tokenAccount(before[i]!),
        next = tokenAccount(simulated.accounts[i]!);
      if (next?.owner === this.feePayer || old?.owner === this.feePayer) return refuse("simulation");
      if (old?.owner === context.wallet && next && (next.owner !== context.wallet || next.mint !== old.mint))
        return refuse("simulation");
      if (old?.owner === context.wallet) deltas.set(old.mint, (deltas.get(old.mint) ?? 0n) - old.amount);
      if (next?.owner === context.wallet) deltas.set(next.mint, (deltas.get(next.mint) ?? 0n) + next.amount);
      if (addresses[i] === outputAta && next?.owner === context.wallet && next.mint === expected.outputMint)
        receivedInAta = next.amount - (old?.amount ?? 0n);
    }
    if (
      (deltas.get(expected.inputMint) ?? 0n) < -BigInt(expected.inAmount) ||
      receivedInAta < BigInt(expected.otherAmountThreshold)
    )
      return refuse("simulation");
    for (const [mint, delta] of deltas)
      if (mint !== expected.inputMint && delta < 0n) return refuse("simulation");
    const walletIndex = addresses.indexOf(context.wallet);
    const preSol = before[walletIndex]?.lamports ?? 0n,
      postSol = simulated.accounts[walletIndex]?.lamports ?? 0n;
    if (postSol > preSol) return refuse("simulation");
    if (expected.inputMint === SWAP_MINTS_V01.SOL) {
      if (preSol - postSol - (deltas.get(SWAP_MINTS_V01.SOL) ?? 0n) > BigInt(expected.inAmount))
        return refuse("simulation");
    } else if (preSol > postSol) return refuse("simulation");
  }

  register(transactionBase64: string, context: SponsorRegisterContext) {
    return this.checked(async () => {
      await this.guard(context.userId);
      if (context.kind !== "swap") return refuse("instruction_not_allowed");
      const validation = await this.validator.validate(transactionBase64, context);
      await this.eligibility(context, validation);
      await this.simulate(transactionBase64, context, validation);
      const now = this.now();
      const record: IssuedRecord = {
        id: context.requestId,
        context,
        messageHash: hash(validation.transaction.messageBytes),
        lastValidBlockHeight: validation.lastValidBlockHeight,
        expectedFeeLamports: validation.expectedFeeLamports.toString(),
        expectedRentLamports: validation.expectedRentLamports.toString(),
        createdAt: now,
        expiresAt: now + 30_000,
        state: "issued",
      };
      await this.options.store.issue(record);
      this.event("issue", { messageHash: record.messageHash });
      return { expiresAt: record.expiresAt };
    });
  }

  cosign(transactionBase64: string, context: { userId: string; requestId: string }) {
    return this.checked(async () => {
      await this.guard(context.userId);
      const record = await this.options.store.get(context.requestId);
      if (record.context.userId !== context.userId) return refuse("record_missing");
      if (record.state !== "issued") return refuse("record_used");
      if (
        record.expiresAt <= this.now() ||
        (await this.options.rpc.blockHeight()) > record.lastValidBlockHeight
      )
        return refuse("record_expired");
      const transaction = decodeTransaction(transactionBase64);
      if (hash(transaction.messageBytes) !== record.messageHash) return refuse("message_mismatch");
      const wallet = address(record.context.wallet),
        signature = transaction.signatures[wallet];
      if (
        !signature ||
        !(await verifySignature(await getPublicKeyFromAddress(wallet), signature, transaction.messageBytes))
      )
        return refuse("message_mismatch");
      await this.options.store.claim(
        record,
        BigInt(record.expectedFeeLamports) + BigInt(record.expectedRentLamports),
      );
      const validation = await this.validator.validate(transactionBase64, record.context);
      if (
        validation.expectedFeeLamports.toString() !== record.expectedFeeLamports ||
        validation.expectedRentLamports > BigInt(record.expectedRentLamports)
      )
        return refuse("fee_cap");
      await this.eligibility(record.context, validation);
      await this.simulate(transactionBase64, record.context, validation);
      await this.guard(context.userId);
      const height = await this.options.rpc.blockHeight();
      if (this.now() >= record.expiresAt || height > record.lastValidBlockHeight)
        return refuse("record_expired");
      const signed = Object.hasOwn(transaction.signatures, this.feePayer)
        ? await partiallySignTransaction([this.keyPair!], transaction)
        : transaction;
      this.event("cosign", {
        messageHash: record.messageHash,
        signature: getSignatureFromTransaction(signed),
      });
      return Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
    });
  }

  async reportOutcome(context: {
    userId: string;
    requestId: string;
    status: "confirmed" | "failed" | "submitted";
    signature?: string;
  }) {
    await this.options.store.report(context.userId, context.requestId, context.status);
    this.event(context.status, { signature: context.signature });
  }
}
