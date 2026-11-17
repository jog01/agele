import { AppError, badRequest, notFound } from "../../lib/errors";
import type { SwapRecord } from "../../models/swaps";
import type { SwapRepository } from "../../repositories/swap.repository";
import { decodeCursor, encodeCursor, type FeedCursor } from "../social/cursor";
import { DisabledFeeSponsor } from "../sponsor/disabled-fee-sponsor";
import { type FeeSponsor, SponsorRejectedError } from "../sponsor/fee-sponsor";
import { isSwapMintAllowed } from "../sponsor/swap-mints";
import {
  type JupiterExecution,
  JupiterExecutionError,
  type JupiterOrder,
  type JupiterSwapClient,
} from "./jupiter-swap.client";

export interface SwapQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

function quoteFields(order: JupiterOrder) {
  return {
    inAmount: order.inAmount,
    outAmount: order.outAmount,
    otherAmountThreshold: order.otherAmountThreshold,
    priceImpactPct: order.priceImpact ?? Number(order.priceImpactPct) * 100,
    slippageBps: order.slippageBps,
    feeBps: order.feeBps,
    router: order.router,
  };
}

const reject = (reason: string): never => {
  throw new AppError(422, "swap_rejected", `Swap rejected: ${reason}`, { reason });
};

export class SwapService {
  constructor(
    private readonly jupiter: JupiterSwapClient,
    private readonly sponsor: FeeSponsor,
    private readonly swaps: SwapRepository,
    private readonly limits: {
      maxSlippageBps: number;
      maxPriceImpactPct: number;
      referralAccount?: string;
      referralFee?: number;
    } = { maxSlippageBps: 300, maxPriceImpactPct: 3 },
    private readonly now: () => number = Date.now,
  ) {}

  private enabled() {
    if (this.sponsor instanceof DisabledFeeSponsor) {
      throw new AppError(503, "trading_disabled", "Trading is disabled in this demo");
    }
  }

  private async sponsored<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SponsorRejectedError && error.reason === "sponsor_disabled") {
        throw new AppError(503, "trading_disabled", "Trading is disabled in this demo");
      }
      throw error;
    }
  }

  async quote(req: SwapQuoteRequest) {
    return quoteFields(await this.jupiter.order({ ...req, slippageBps: req.slippageBps ?? 50 }));
  }

  async build(userId: string, wallet: string, req: SwapQuoteRequest) {
    this.enabled();
    const slippageBps = req.slippageBps ?? 50;
    if (slippageBps > this.limits.maxSlippageBps) reject("slippage_exceeded");
    if (!isSwapMintAllowed(req.inputMint) || !isSwapMintAllowed(req.outputMint)) reject("mint_not_allowed");
    const order = await this.jupiter.order({
      ...req,
      slippageBps,
      taker: wallet,
      payer: this.sponsor.feePayer,
      ...(this.limits.referralAccount
        ? { referralAccount: this.limits.referralAccount, referralFee: this.limits.referralFee }
        : {}),
    });
    if (order.inputMint !== req.inputMint) reject("input_mint_mismatch");
    if (order.outputMint !== req.outputMint) reject("output_mint_mismatch");
    if (order.inAmount !== req.amount) reject("amount_mismatch");
    if (order.taker !== wallet) reject("taker_mismatch");
    if (
      order.rentFeePayer !== this.sponsor.feePayer ||
      (order.prioritizationFeePayer != null && order.prioritizationFeePayer !== this.sponsor.feePayer) ||
      (order.router !== "jupiterz" && order.signatureFeePayer !== this.sponsor.feePayer) ||
      (order.router === "jupiterz" && (!order.signatureFeePayer || order.signatureFeePayer === wallet))
    )
      reject("payer_mismatch");
    const transaction = order.transaction;
    if (!transaction) return reject("transaction_missing");
    const quote = quoteFields(order);
    if (quote.slippageBps > this.limits.maxSlippageBps) reject("slippage_exceeded");
    if (Math.abs(quote.priceImpactPct) > this.limits.maxPriceImpactPct) reject("price_impact_exceeded");
    const { expiresAt } = await this.sponsored(() =>
      this.sponsor.register(transaction, {
        userId,
        wallet,
        kind: "swap",
        requestId: order.requestId,
        swap: {
          inputMint: order.inputMint,
          outputMint: order.outputMint,
          inAmount: order.inAmount,
          otherAmountThreshold: order.otherAmountThreshold,
          router: order.router,
          lastValidBlockHeight: order.lastValidBlockHeight,
          feeBps: order.feeBps,
          referralAccount: this.limits.referralAccount,
        },
      }),
    );
    const expiry = Math.min(expiresAt, this.now() + 30_000);
    await this.swaps.create({
      requestId: order.requestId,
      userId,
      wallet,
      inputMint: order.inputMint,
      outputMint: order.outputMint,
      inAmount: order.inAmount,
      quotedOutAmount: order.outAmount,
      expiresAt: new Date(expiry),
    });
    return { requestId: order.requestId, transaction, expiresAt: expiry, ...quote };
  }

  private async record(userId: string, requestId: string) {
    const row = await this.swaps.find(userId, requestId);
    if (!row) throw notFound("Swap");
    return row;
  }

  private status(row: SwapRecord) {
    return row.status === "issued" && row.expiresAt.getTime() <= this.now()
      ? ("expired" as const)
      : row.status;
  }

  async get(userId: string, requestId: string) {
    const row = await this.record(userId, requestId);
    return this.summary(row);
  }

  private summary(row: SwapRecord) {
    return {
      requestId: row.requestId,
      status: this.status(row),
      signature: row.signature ?? undefined,
      inAmount: row.inputAmountResult ?? row.inAmount,
      outAmount: row.outputAmountResult ?? row.quotedOutAmount,
      error: row.error ?? undefined,
    };
  }

  async list(userId: string, input: { limit: number; cursor?: string }) {
    let cursor: FeedCursor | undefined;
    if (input.cursor !== undefined) {
      try {
        cursor = decodeCursor(input.cursor);
        if (cursor.id.length > 200 || !Number.isFinite(new Date(cursor.createdAt).getTime()))
          throw new Error();
      } catch {
        throw badRequest("Invalid swaps cursor");
      }
    }
    const rows = await this.swaps.list(userId, { limit: input.limit + 1, cursor });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        ...this.summary(row),
        inputMint: row.inputMint,
        outputMint: row.outputMint,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ createdAt: last.createdAt.getTime(), id: last.requestId })
          : null,
    };
  }

  async submit(userId: string, requestId: string, signedTransaction: string) {
    this.enabled();
    const row = await this.record(userId, requestId);
    if (this.status(row) === "expired") throw new SponsorRejectedError("record_expired");
    if (!(await this.swaps.claim(userId, requestId, new Date(this.now())))) {
      throw new SponsorRejectedError("record_used");
    }
    let cosigned: string;
    try {
      cosigned = await this.sponsored(() => this.sponsor.cosign(signedTransaction, { userId, requestId }));
    } catch (error) {
      await this.swaps.finish(userId, requestId, {
        status: "failed",
        signature: null,
        error: error instanceof SponsorRejectedError ? error.reason : "Sponsorship unavailable",
        errorCode: null,
        inputAmountResult: null,
        outputAmountResult: null,
      });
      await this.sponsor.reportOutcome?.({ userId, requestId, status: "failed" });
      throw error;
    }
    let execution: JupiterExecution;
    try {
      execution = await this.jupiter.execute({ signedTransaction: cosigned, requestId });
    } catch (error) {
      if (error instanceof JupiterExecutionError) execution = error.result;
      else {
        await this.swaps.finish(userId, requestId, {
          status: "submitted",
          signature: null,
          error: "Execution outcome unknown",
          errorCode: null,
          inputAmountResult: null,
          outputAmountResult: null,
        });
        await this.sponsor.reportOutcome?.({ userId, requestId, status: "submitted" });
        return { status: "submitted" as const };
      }
    }
    const status = execution.status === "Success" ? ("confirmed" as const) : ("failed" as const);
    await this.swaps.finish(userId, requestId, {
      status,
      signature: execution.signature ?? null,
      error: execution.error ?? null,
      errorCode: execution.code === undefined ? null : String(execution.code),
      inputAmountResult: execution.inputAmountResult ?? null,
      outputAmountResult: execution.outputAmountResult ?? null,
    });
    await this.sponsor.reportOutcome?.({ userId, requestId, status, signature: execution.signature });
    return {
      status,
      signature: execution.signature,
      inputAmountResult: execution.inputAmountResult,
      outputAmountResult: execution.outputAmountResult,
      ...(status === "failed" ? { code: execution.code, error: execution.error } : {}),
    };
  }
}
