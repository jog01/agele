import { describe, expect, it, mock } from "bun:test";
import { SponsorRejectedError } from "../src/services/sponsor/fee-sponsor";
import type { UserService } from "../src/services/user.service";
import { testApp } from "./helpers";
import { PAYER, REQUEST, swapSetup, USER, WALLET } from "./swap-helpers";

function setup(linked = true, swaps = swapSetup().service) {
  const users = {
    ensureUser: async () => ({
      id: USER,
      walletAddress: linked ? WALLET : null,
      wallets: linked ? [{ address: WALLET, isPrimary: true, chainType: "solana" }] : [],
    }),
  } as unknown as UserService;
  const consume = mock(async () => {});
  const app = testApp({
    swaps,
    users,
    auth: { verify: async () => ({ privyDid: "did:privy:test", sessionId: "session" }) },
    swapRateLimiter: { consume },
  });
  return { app, consume };
}
const headers = { authorization: "Bearer good", "content-type": "application/json" };
const post = (body: unknown) => ({ method: "POST", headers, body: JSON.stringify(body) });

describe("swap HTTP routes", () => {
  it("previews publicly and exposes authenticated build, submit and status contracts", async () => {
    const { app, consume } = setup();
    const quote = await app.request(`/v1/swaps/quote?${new URLSearchParams(REQUEST)}`);
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({
      inAmount: "10000000",
      outAmount: "39787085",
      slippageBps: 50,
    });
    const build = await app.request("/v1/swaps", post(REQUEST));
    expect(build.status).toBe(201);
    const built = (await build.json()) as { requestId: string; transaction: string; expiresAt: number };
    expect(built.transaction).toBe("dW5zaWduZWQ=");
    expect(typeof built.expiresAt).toBe("number");
    const issued = await app.request(`/v1/swaps/${built.requestId}`, { headers });
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      requestId: built.requestId,
      status: "issued",
      inAmount: "10000000",
      outAmount: "39787085",
    });
    const submit = await app.request(
      `/v1/swaps/${built.requestId}/submit`,
      post({ signedTransaction: "c2lnbmVk" }),
    );
    expect(submit.status).toBe(200);
    expect(await submit.json()).toEqual({
      status: "confirmed",
      signature: "test-signature",
      inputAmountResult: "10000000",
      outputAmountResult: "39787085",
    });
    const status = await app.request(`/v1/swaps/${built.requestId}`, { headers });
    expect(await status.json()).toMatchObject({ status: "confirmed", signature: "test-signature" });
    expect(consume).toHaveBeenCalledWith(`user:${USER}`);
  });

  for (const [path, method] of [
    ["/v1/swaps", "POST"],
    ["/v1/swaps/request/submit", "POST"],
    ["/v1/swaps/request", "GET"],
  ]) {
    it(`requires auth: ${method} ${path}`, async () => {
      const { app } = setup();
      const res = await app.request(path!, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: "unauthorized" } });
    });
  }

  it("returns 409 without a primary linked wallet", async () => {
    const { app } = setup(false);
    const res = await app.request("/v1/swaps", post(REQUEST));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "wallet_not_linked" } });
  });

  it("does not reveal missing or other users' records", async () => {
    const fake = swapSetup();
    const built = await fake.service.build("other-user", WALLET, REQUEST);
    const { app } = setup(true, fake.service);
    for (const requestId of [built.requestId, "missing"]) {
      expect((await app.request(`/v1/swaps/${requestId}`, { headers })).status).toBe(404);
      expect(
        (await app.request(`/v1/swaps/${requestId}/submit`, post({ signedTransaction: "signed" }))).status,
      ).toBe(404);
    }
  });

  it("maps sponsor rejection to the shared 422 error shape", async () => {
    const fake = swapSetup({
      sponsor: {
        feePayer: PAYER,
        register: async () => ({ expiresAt: Date.now() + 30_000 }),
        cosign: async () => {
          throw new SponsorRejectedError("message_mismatch");
        },
      },
    });
    const { requestId } = await fake.service.build(USER, WALLET, REQUEST);
    const { app } = setup(true, fake.service);
    const res = await app.request(`/v1/swaps/${requestId}/submit`, post({ signedTransaction: "signed" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "sponsor_rejected", message: "Transaction not sponsored: message_mismatch" },
    });
  });

  it("the default container honestly disables build and submit", async () => {
    const enabledSetup = setup();
    // Keep the default container's disabled SwapService, but provide authenticated wallet linkage.
    const app = testApp({
      auth: { verify: async () => ({ privyDid: "did:privy:test", sessionId: "session" }) },
      users: {
        ensureUser: async () => ({
          id: USER,
          walletAddress: WALLET,
          wallets: [{ address: WALLET, isPrimary: true, chainType: "solana" }],
        }),
      } as unknown as UserService,
      swapRateLimiter: { consume: enabledSetup.consume },
    });
    for (const [path, body] of [
      ["/v1/swaps", REQUEST],
      ["/v1/swaps/missing/submit", { signedTransaction: "signed" }],
    ] as const) {
      const res = await app.request(path, post(body));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: "trading_disabled" } });
    }
  });

  it("rejects empty, numeric or noninteger amounts, unexpected fields, and empty signed transactions", async () => {
    const { app } = setup();
    for (const amount of ["", "0", "-1", "1.5", "01", 100]) {
      expect((await app.request("/v1/swaps", post({ ...REQUEST, amount }))).status).toBe(400);
    }
    expect((await app.request("/v1/swaps", post({ ...REQUEST, payer: PAYER }))).status).toBe(400);
    expect((await app.request("/v1/swaps/missing/submit", post({ signedTransaction: "" }))).status).toBe(400);
    expect(
      (await app.request(`/v1/swaps/quote?${new URLSearchParams({ ...REQUEST, slippageBps: "bad" })}`))
        .status,
    ).toBe(400);
  });
});
