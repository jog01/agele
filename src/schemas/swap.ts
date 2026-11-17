import { z } from "@hono/zod-openapi";

const mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const SwapRequest = z
  .object({
    inputMint: mint,
    outputMint: mint,
    amount: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(78),
    slippageBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export const QuoteQuery = SwapRequest.extend({
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
});
export const QuoteSchema = z.object({
  inAmount: z.string(),
  outAmount: z.string(),
  otherAmountThreshold: z.string(),
  priceImpactPct: z.number().openapi({ description: "Price impact in percentage points (3 means 3%)" }),
  slippageBps: z.number(),
  feeBps: z.number(),
  router: z.string(),
});
export const BuiltSwapSchema = QuoteSchema.extend({
  requestId: z.string(),
  transaction: z.string(),
  expiresAt: z.number().openapi({ description: "Unix timestamp in milliseconds" }),
});
export const SwapIdParam = z.object({ requestId: z.string().min(1).max(200) });
export const SubmitSwapRequest = z.object({ signedTransaction: z.string().min(1).max(4096) }).strict();
export const SwapResultSchema = z.object({
  status: z.enum(["confirmed", "failed", "submitted"]),
  signature: z.string().optional(),
  inputAmountResult: z.string().optional(),
  outputAmountResult: z.string().optional(),
  code: z.number().optional(),
  error: z.string().optional(),
});
export const SwapStatusSchema = z.object({
  requestId: z.string(),
  status: z.enum(["issued", "submitted", "confirmed", "failed", "expired"]),
  signature: z.string().optional(),
  inAmount: z.string().optional(),
  outAmount: z.string().optional(),
  error: z.string().optional(),
});
export const SwapListQuery = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const SwapListItemSchema = SwapStatusSchema.extend({
  inputMint: mint,
  outputMint: mint,
  inAmount: z.string(),
  outAmount: z.string(),
  createdAt: z.iso.datetime().openapi({ description: "Creation time in UTC; ISO 8601" }),
});
export const SwapListSchema = z.object({
  items: z.array(SwapListItemSchema),
  nextCursor: z.string().nullable(),
});
