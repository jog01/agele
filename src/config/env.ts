import { z } from "zod";
import { MockMarketDataProvider } from "../services/market-data/mock.provider";

const boolish = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((v) => v.split(",").map((s) => s.trim())),

    DATABASE_URL: z.url().default("postgres://fomo:fomo@localhost:5432/fomo"),
    REDIS_URL: z.string().default("redis://localhost:6379"),

    PRIVY_APP_ID: z.string().optional(),
    PRIVY_APP_SECRET: z.string().optional(),
    PRIVY_VERIFICATION_KEY: z.string().optional(),

    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    HELIUS_API_KEY: z.string().optional(),
    JUPITER_API_KEY: z.string().optional(),
    JUPITER_BASE_URL: z.url().default("https://api.jup.ag"),
    FEE_PAYER_PUBKEY: z.string().optional(),
    FEE_PAYER_SECRET: z.string().optional(),
    SPONSOR_ENABLED: boolish.default(false),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
    MAX_PRICE_IMPACT_PCT: z.coerce.number().positive().default(3),
    MAX_CU_PRICE_MICROLAMPORTS: z.coerce.number().int().nonnegative().safe().default(2_000_000),
    MAX_LAMPORTS_PER_TX: z.coerce.number().int().positive().max(1_000_000_000).default(10_000_000),
    DAILY_SPEND_CAP_SOL: z.coerce.number().positive().max(1000).default(1),
    SPONSOR_REFERRAL_ACCOUNT: z.string().optional(),
    SPONSOR_REFERRAL_FEE_BPS: z.coerce.number().int().min(50).max(255).default(50),
    BIRDEYE_API_KEY: z.string().optional(),
    MARKET_DATA_PROVIDER: z.enum(["mock", "live"]).default("live"),
    MARKET_TOKEN_ALLOWLIST: z
      .string()
      .default(MockMarketDataProvider.mints.join(","))
      .transform((v) => [
        ...new Set(
          v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]),
    ENABLE_MOCK_FEED: boolish.default(true),

    OTEL_SERVICE_NAME: z.string().default("fomo-api"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  })
  .refine((v) => !v.FEE_PAYER_SECRET || v.NODE_ENV === "development", {
    message: "FEE_PAYER_SECRET is development-only",
    path: ["FEE_PAYER_SECRET"],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Blank values from a copied .env.example mean "unset", not "".
  const defined = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = EnvSchema.safeParse(defined);
  if (!parsed.success) {
    console.error("Invalid environment:", z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
