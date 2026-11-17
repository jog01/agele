import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../src/config/env";
import { closeDb, getDb } from "../src/db/client";
import { logger } from "../src/lib/logger";
import { wallets } from "../src/models";

const configSchema = z.object({ apiKey: z.string().min(1), secret: z.string().min(1), webhookURL: z.url() });
const webhookSchema = z.object({ webhookID: z.string().min(1), webhookURL: z.string() });
const BASE_URL = "https://mainnet.helius-rpc.com/v0/webhooks";

export async function syncHeliusWebhook(
  config: z.infer<typeof configSchema>,
  addresses: string[],
  request: typeof fetch = fetch,
) {
  configSchema.parse(config);
  const accountAddresses = [...new Set(addresses)].sort();
  if (!accountAddresses.length) throw new Error("No linked Solana wallets; refusing an unfiltered webhook");
  if (accountAddresses.length > 100000) throw new Error("Helius webhook supports at most 100000 addresses");
  const call = async (path: string, method: string, body?: unknown) => {
    try {
      const response = await request(`${BASE_URL}${path}?api-key=${encodeURIComponent(config.apiKey)}`, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error(`Helius webhook ${method} request failed`);
    }
  };
  const existing = z
    .array(webhookSchema)
    .parse(await call("", "GET"))
    .find((webhook) => webhook.webhookURL === config.webhookURL);
  const body = {
    webhookURL: config.webhookURL,
    transactionTypes: ["ANY"],
    accountAddresses,
    webhookType: "enhanced",
    authHeader: config.secret,
  };
  const method = existing ? "PUT" : "POST";
  const result = webhookSchema.parse(
    await call(existing ? `/${encodeURIComponent(existing.webhookID)}` : "", method, body),
  );
  return {
    webhookID: result.webhookID,
    addresses: accountAddresses.length,
    action: existing ? "updated" : "created",
  };
}

if (import.meta.main) {
  try {
    const config = configSchema.parse({
      apiKey: env.HELIUS_API_KEY,
      secret: env.HELIUS_WEBHOOK_SECRET,
      webhookURL: env.HELIUS_WEBHOOK_URL,
    });
    const linked = await getDb()
      .select({ address: wallets.address })
      .from(wallets)
      .where(eq(wallets.chainType, "solana"));
    logger.info(
      await syncHeliusWebhook(
        config,
        linked.map((wallet) => wallet.address),
      ),
      "Helius webhook synced",
    );
  } catch {
    logger.error("Helius sync failed: check required env, linked wallets, and Helius availability");
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
