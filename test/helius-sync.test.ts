import { describe, expect, it } from "bun:test";
import { syncHeliusWebhook } from "../scripts/sync-helius-webhook";

describe("Helius webhook sync", () => {
  const config = { apiKey: "key", secret: "secret", webhookURL: "https://example.com/v1/webhooks/helius" };
  it("creates enhanced ANY webhooks or updates a matching URL", async () => {
    for (const existing of [false, true]) {
      const calls: { url: string; method: string; body?: unknown }[] = [];
      const request = (async (input, init) => {
        calls.push({
          url: String(input),
          method: init!.method!,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json(
          init!.method === "GET"
            ? existing
              ? [{ webhookID: "id", webhookURL: config.webhookURL }]
              : []
            : { webhookID: "id", webhookURL: config.webhookURL },
        );
      }) as typeof fetch;
      expect(await syncHeliusWebhook(config, ["b", "a", "a"], request)).toEqual({
        webhookID: "id",
        addresses: 2,
        action: existing ? "updated" : "created",
      });
      expect(calls[1]).toEqual({
        url: `https://mainnet.helius-rpc.com/v0/webhooks${existing ? "/id" : ""}?api-key=key`,
        method: existing ? "PUT" : "POST",
        body: {
          webhookURL: config.webhookURL,
          transactionTypes: ["ANY"],
          accountAddresses: ["a", "b"],
          webhookType: "enhanced",
          authHeader: "secret",
        },
      });
    }
  });
  it("refuses empty wallet sets and does not expose credentials on request failures", async () => {
    await expect(syncHeliusWebhook(config, [])).rejects.toThrow("No linked Solana wallets");
    const request = (async () => {
      throw new Error("https://host?api-key=key");
    }) as unknown as typeof fetch;
    await expect(syncHeliusWebhook(config, ["wallet"], request)).rejects.toThrow(
      "Helius webhook GET request failed",
    );
  });
});
