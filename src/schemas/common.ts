import { z } from "@hono/zod-openapi";

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "not_found" }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

export const MintParam = z.object({
  mint: z
    .string()
    .min(32)
    .max(44)
    .openapi({ param: { name: "mint", in: "path" }, example: "So11111111111111111111111111111111111111112" }),
});

export const errorResponse = (description: string) => ({
  content: { "application/json": { schema: ErrorSchema } },
  description,
});
