import { z } from "zod";
import { AppError } from "../../lib/errors";

const amount = z.string().regex(/^\d+$/);
export const OrderSchema = z
  .object({
    requestId: z.string().min(1),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: amount,
    outAmount: amount,
    otherAmountThreshold: amount,
    slippageBps: z.number().int().nonnegative(),
    priceImpact: z.number().optional(),
    priceImpactPct: z.string().optional(),
    feeBps: z.number().nonnegative(),
    router: z.string().min(1),
    taker: z.string().nullable().optional(),
    signatureFeePayer: z.string().nullable().optional(),
    prioritizationFeePayer: z.string().nullable().optional(),
    rentFeePayer: z.string().nullable().optional(),
    lastValidBlockHeight: z.string().optional(),
    transaction: z.string().nullable(),
  })
  .refine(
    (v) =>
      v.priceImpact !== undefined ||
      (v.priceImpactPct !== undefined && Number.isFinite(Number(v.priceImpactPct))),
    "Missing price impact",
  );

export const ExecuteSchema = z
  .object({
    status: z.enum(["Success", "Failed"]),
    signature: z.string().min(1).optional(),
    code: z.number().optional(),
    error: z.string().optional(),
    inputAmountResult: amount.optional(),
    outputAmountResult: amount.optional(),
  })
  .refine((v) => v.status !== "Success" || !!v.signature, "Success requires a signature");
export type JupiterOrder = z.infer<typeof OrderSchema>;
export type JupiterExecution = z.infer<typeof ExecuteSchema>;
const ExecuteFailureSchema = z.object({ code: z.number(), error: z.string() });
export class JupiterExecutionError extends AppError {
  constructor(readonly result: JupiterExecution) {
    super(502, "upstream_error", "Jupiter rejected execution");
  }
}
export interface OrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  payer?: string;
  slippageBps?: number;
  referralAccount?: string;
  referralFee?: number;
}
export type SwapFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class JupiterSwapClient {
  constructor(
    private readonly baseUrl = "https://api.jup.ag",
    private readonly apiKey?: string,
    private readonly fetcher: SwapFetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
      if (!response.ok) {
        if (path === "/swap/v2/execute" && response.status === 400) {
          const failure = ExecuteFailureSchema.safeParse(await response.json());
          if (failure.success) {
            const signed = (JSON.parse(String(init.body)) as { signedTransaction: string }).signedTransaction;
            throw new JupiterExecutionError({
              status: "Failed",
              code: failure.data.code,
              error: failure.data.error.replaceAll(signed, "[redacted]"),
            });
          }
        }
        throw new Error("Upstream HTTP error");
      }
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof JupiterExecutionError) throw error;
      throw new AppError(502, "upstream_error", "Jupiter request failed");
    }
  }

  order(req: OrderRequest) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.request(`/swap/v2/order?${query}`, OrderSchema);
  }

  execute(req: { signedTransaction: string; requestId: string }) {
    return this.request("/swap/v2/execute", ExecuteSchema, { method: "POST", body: JSON.stringify(req) });
  }
}
