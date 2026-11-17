import { z } from "@hono/zod-openapi";

export const MeSchema = z
  .object({
    id: z.string(),
    privyDid: z.string(),
    walletAddress: z.string().nullable(),
    handle: z.string().nullable(),
    wallets: z.array(
      z.object({
        address: z.string(),
        chainType: z.literal("solana"),
        walletClientType: z.string(),
        privyWalletId: z.string().nullable(),
        isPrimary: z.boolean(),
      }),
    ),
  })
  .openapi("Me");
