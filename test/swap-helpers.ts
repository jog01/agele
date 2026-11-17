import { mock } from "bun:test";
import type { NewSwapRecord, SwapRecord } from "../src/models/swaps";
import type { SwapListOptions, SwapOutcome, SwapRepository } from "../src/repositories/swap.repository";
import type { FeeSponsor } from "../src/services/sponsor/fee-sponsor";
import { SWAP_MINTS_V01 } from "../src/services/sponsor/swap-mints";
import { JupiterSwapClient, type SwapFetch } from "../src/services/trading/jupiter-swap.client";
import { SwapService } from "../src/services/trading/swap.service";
import execution from "./fixtures/jupiter-execute-success.json";
import preview from "./fixtures/jupiter-order.json";
import { FIXED_NOW } from "./helpers";

export const USER = "00000000-0000-0000-0000-000000000001";
export const WALLET = "11111111111111111111111111111111";
export const PAYER = SWAP_MINTS_V01.SOL;
export const REQUEST = {
  inputMint: preview.inputMint,
  outputMint: preview.outputMint,
  amount: preview.inAmount,
};
export const builtOrder = () => ({
  ...preview,
  taker: WALLET,
  signatureFeePayer: PAYER,
  rentFeePayer: PAYER,
  prioritizationFeePayer: PAYER,
  transaction: "dW5zaWduZWQ=",
});

export class MemorySwapRepository implements SwapRepository {
  readonly records = new Map<string, SwapRecord>();
  async create(record: NewSwapRecord) {
    if (this.records.has(record.requestId)) throw new Error("duplicate requestId");
    this.records.set(record.requestId, {
      ...record,
      status: record.status ?? "issued",
      signature: null,
      error: null,
      errorCode: null,
      inputAmountResult: null,
      outputAmountResult: null,
      createdAt: new Date(FIXED_NOW),
      updatedAt: new Date(FIXED_NOW),
    });
  }
  async find(userId: string, requestId: string) {
    const record = this.records.get(requestId);
    return record?.userId === userId ? record : undefined;
  }
  async list(userId: string, { limit, cursor }: SwapListOptions) {
    return [...this.records.values()]
      .filter(
        (row) =>
          row.userId === userId &&
          (!cursor ||
            row.createdAt.getTime() < cursor.createdAt ||
            (row.createdAt.getTime() === cursor.createdAt && row.requestId < cursor.id)),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          (a.requestId < b.requestId ? 1 : a.requestId > b.requestId ? -1 : 0),
      )
      .slice(0, limit);
  }
  async claim(userId: string, requestId: string, now: Date) {
    const record = await this.find(userId, requestId);
    if (record?.status !== "issued" || record.expiresAt <= now) return false;
    record.status = "submitted";
    return true;
  }
  async finish(userId: string, requestId: string, outcome: SwapOutcome) {
    Object.assign((await this.find(userId, requestId))!, outcome);
  }
}

export function swapSetup(
  options: {
    order?: Record<string, unknown>;
    execute?: unknown;
    executeStatus?: number;
    executeError?: boolean;
    sponsor?: FeeSponsor;
  } = {},
) {
  let now = FIXED_NOW;
  const register = mock(async () => ({ expiresAt: now + 30_000 }));
  const cosign = mock(async () => "Y29zaWduZWQ=");
  const sponsor: FeeSponsor = options.sponsor ?? { feePayer: PAYER, register, cosign };
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: SwapFetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/execute")) {
      if (options.executeError) throw new Error("network timeout");
      return Response.json(options.execute ?? execution, { status: options.executeStatus ?? 200 });
    }
    const order = options.order ?? (url.searchParams.has("taker") ? builtOrder() : preview);
    return Response.json(order);
  };
  const repo = new MemorySwapRepository();
  const client = new JupiterSwapClient("https://api.jup.ag", "test-key", fetcher);
  const service = new SwapService(client, sponsor, repo, undefined, () => now);
  return {
    service,
    repo,
    calls,
    register,
    cosign,
    setNow: (value: number) => {
      now = value;
    },
  };
}
