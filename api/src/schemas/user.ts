import { z } from "@hono/zod-openapi";

export const MeSchema = z
  .object({
    id: z.string(),
    privyDid: z.string(),
    walletAddress: z.string().nullable(),
    handle: z.string().nullable(),
  })
  .openapi("Me");
