import { describe, expect, it, mock } from "bun:test";
import { DisabledFeeSponsor } from "../src/services/sponsor/disabled-fee-sponsor";
import { SponsorRejectedError } from "../src/services/sponsor/fee-sponsor";
import { SWAP_MINTS_V01 } from "../src/services/sponsor/swap-mints";
import { JupiterSwapClient, type SwapFetch } from "../src/services/trading/jupiter-swap.client";
import failed from "./fixtures/jupiter-execute-failed.json";
import preview from "./fixtures/jupiter-order.json";
import { FIXED_NOW } from "./helpers";
import { builtOrder, PAYER, REQUEST, swapSetup, USER, WALLET } from "./swap-helpers";

describe("SwapService", () => {
  for (const status of ["confirmed", "failed", "submitted"] as const)
    it(`reports ${status} outcomes to the sponsor`, async () => {
      const reportOutcome = mock(async () => {});
      const { service } = swapSetup({
        execute: status === "failed" ? failed : undefined,
        executeStatus: status === "failed" ? 400 : 200,
        executeError: status === "submitted",
        sponsor: {
          feePayer: PAYER,
          register: async () => ({ expiresAt: FIXED_NOW + 30_000 }),
          cosign: async () => "Y29zaWduZWQ=",
          reportOutcome,
        },
      });
      const built = await service.build(USER, WALLET, REQUEST);
      await service.submit(USER, built.requestId, "user-signed");
      expect(reportOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER, requestId: built.requestId, status }),
      );
    });
  it("previews without a taker and builds/registers before cosigning and executing only cosigned bytes", async () => {
    const { service, calls, register, cosign, repo } = swapSetup();
    const quote = await service.quote(REQUEST);
    expect(quote).toEqual({
      inAmount: preview.inAmount,
      outAmount: preview.outAmount,
      otherAmountThreshold: preview.otherAmountThreshold,
      priceImpactPct: preview.priceImpact,
      slippageBps: 50,
      feeBps: 0,
      router: "metis",
    });
    expect(calls[0]!.url.searchParams.has("taker")).toBe(false);
    expect(calls[0]!.url.searchParams.has("payer")).toBe(false);
    const built = await service.build(USER, WALLET, REQUEST);
    expect(built).toMatchObject({
      ...quote,
      expiresAt: FIXED_NOW + 30_000,
      transaction: builtOrder().transaction,
    });
    expect(calls[1]!.url.searchParams.get("taker")).toBe(WALLET);
    expect(calls[1]!.url.searchParams.get("payer")).toBe(PAYER);
    expect(calls[1]!.url.searchParams.get("slippageBps")).toBe("50");
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(built.transaction, {
      userId: USER,
      wallet: WALLET,
      kind: "swap",
      requestId: built.requestId,
      swap: {
        inputMint: REQUEST.inputMint,
        outputMint: REQUEST.outputMint,
        inAmount: REQUEST.amount,
        otherAmountThreshold: preview.otherAmountThreshold,
        router: preview.router,
        lastValidBlockHeight: undefined,
        feeBps: preview.feeBps,
        referralAccount: undefined,
      },
    });
    expect(cosign).not.toHaveBeenCalled();
    expect((await service.get(USER, built.requestId)).status).toBe("issued");
    const result = await service.submit(USER, built.requestId, "dXNlci1zaWduZWQ=");
    expect(result).toEqual({
      status: "confirmed",
      signature: "test-signature",
      inputAmountResult: "10000000",
      outputAmountResult: "39787085",
    });
    expect(cosign).toHaveBeenCalledTimes(1);
    expect(cosign).toHaveBeenCalledWith("dXNlci1zaWduZWQ=", { userId: USER, requestId: built.requestId });
    expect(JSON.parse(String(calls[2]!.init!.body))).toEqual({
      signedTransaction: "Y29zaWduZWQ=",
      requestId: built.requestId,
    });
    expect(JSON.stringify(result)).not.toContain("Y29zaWduZWQ=");
    expect(JSON.stringify([...repo.records.values()])).not.toContain("Y29zaWduZWQ=");
    expect(await service.get(USER, built.requestId)).toMatchObject({
      status: "confirmed",
      signature: "test-signature",
      inAmount: "10000000",
      outAmount: "39787085",
    });
    await expect(service.submit(USER, built.requestId, "retry")).rejects.toMatchObject({
      reason: "record_used",
    });
    expect(cosign).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
  });

  const unsafe: [string, unknown, string][] = [
    ["inputMint", SWAP_MINTS_V01.SOL, "input_mint_mismatch"],
    ["outputMint", SWAP_MINTS_V01.SOL, "output_mint_mismatch"],
    ["inAmount", "10000001", "amount_mismatch"],
    ["taker", PAYER, "taker_mismatch"],
    ["taker", null, "taker_mismatch"],
    ["rentFeePayer", WALLET, "payer_mismatch"],
    ["rentFeePayer", null, "payer_mismatch"],
    ["signatureFeePayer", WALLET, "payer_mismatch"],
    ["signatureFeePayer", null, "payer_mismatch"],
    ["prioritizationFeePayer", WALLET, "payer_mismatch"],
    ["transaction", null, "transaction_missing"],
    ["transaction", "", "transaction_missing"],
    ["slippageBps", 301, "slippage_exceeded"],
    ["priceImpact", 3.01, "price_impact_exceeded"],
    ["priceImpact", -3.01, "price_impact_exceeded"],
  ];
  for (const [field, value, reason] of unsafe) {
    it(`rejects ${field}=${value} before register`, async () => {
      const { service, register, repo } = swapSetup({ order: { ...builtOrder(), [field]: value } });
      await expect(service.build(USER, WALLET, REQUEST)).rejects.toMatchObject({
        status: 422,
        code: "swap_rejected",
        details: { reason },
      });
      expect(register).not.toHaveBeenCalled();
      expect(repo.records.size).toBe(0);
    });
  }

  it("rejects nonallowlisted mints and requested slippage before requesting an order", async () => {
    const { service, calls } = swapSetup();
    for (const req of [
      { ...REQUEST, inputMint: WALLET },
      { ...REQUEST, outputMint: WALLET },
      { ...REQUEST, slippageBps: 301 },
    ]) {
      await expect(service.build(USER, WALLET, req)).rejects.toMatchObject({
        status: 422,
        code: "swap_rejected",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts cap boundaries, missing optional priority payer, and normalizes legacy impact ratios", async () => {
    const { service } = swapSetup({
      order: {
        ...builtOrder(),
        slippageBps: 300,
        priceImpact: undefined,
        priceImpactPct: "0.03",
        prioritizationFeePayer: undefined,
      },
    });
    expect(await service.build(USER, WALLET, { ...REQUEST, slippageBps: 300 })).toMatchObject({
      priceImpactPct: 3,
      slippageBps: 300,
    });
    const rejected = swapSetup({
      order: { ...builtOrder(), priceImpact: undefined, priceImpactPct: "0.031" },
    });
    await expect(rejected.service.build(USER, WALLET, REQUEST)).rejects.toMatchObject({
      details: { reason: "price_impact_exceeded" },
    });
  });

  it("allows a JupiterZ market-maker signer but never the taker", async () => {
    const valid = swapSetup({
      order: { ...builtOrder(), router: "jupiterz", signatureFeePayer: SWAP_MINTS_V01.JTO },
    });
    await valid.service.build(USER, WALLET, REQUEST);
    expect(valid.register).toHaveBeenCalledTimes(1);
    for (const signatureFeePayer of [WALLET, null]) {
      const invalid = swapSetup({ order: { ...builtOrder(), router: "jupiterz", signatureFeePayer } });
      await expect(invalid.service.build(USER, WALLET, REQUEST)).rejects.toMatchObject({
        details: { reason: "payer_mismatch" },
      });
    }
  });

  it("maps sponsor rejections and never executes", async () => {
    const sponsor = {
      feePayer: PAYER,
      register: async () => ({ expiresAt: FIXED_NOW + 20_000 }),
      cosign: async () => {
        throw new SponsorRejectedError("message_mismatch");
      },
    };
    const { service, calls } = swapSetup({ sponsor });
    const built = await service.build(USER, WALLET, REQUEST);
    expect(built.expiresAt).toBe(FIXED_NOW + 20_000);
    await expect(service.submit(USER, built.requestId, "bad")).rejects.toMatchObject({
      status: 422,
      code: "sponsor_rejected",
      reason: "message_mismatch",
    });
    expect(calls).toHaveLength(1);
    expect(await service.get(USER, built.requestId)).toMatchObject({
      status: "failed",
      error: "message_mismatch",
    });
  });

  it("disabled sponsor returns 503 for build/submit; preview works", async () => {
    const { service, calls } = swapSetup({ sponsor: new DisabledFeeSponsor() });
    await service.quote(REQUEST);
    await expect(service.build(USER, WALLET, REQUEST)).rejects.toMatchObject({
      status: 503,
      code: "trading_disabled",
    });
    await expect(service.submit(USER, "any", "signed")).rejects.toMatchObject({
      status: 503,
      code: "trading_disabled",
    });
    expect(calls).toHaveLength(1);
  });

  it("hides other users' swaps, derives expiry, and does not cosign expired records", async () => {
    const { service, cosign, setNow } = swapSetup();
    const built = await service.build(USER, WALLET, REQUEST);
    for (const requestId of [built.requestId, "missing"]) {
      await expect(service.get("other", requestId)).rejects.toMatchObject({ status: 404 });
      await expect(service.submit("other", requestId, "signed")).rejects.toMatchObject({ status: 404 });
    }
    setNow(built.expiresAt);
    expect(await service.get(USER, built.requestId)).toMatchObject({ status: "expired" });
    await expect(service.submit(USER, built.requestId, "signed")).rejects.toMatchObject({
      reason: "record_expired",
    });
    expect(cosign).not.toHaveBeenCalled();
  });

  it("claims concurrent submissions only once", async () => {
    const { service, cosign, calls } = swapSetup();
    const { requestId } = await service.build(USER, WALLET, REQUEST);
    const results = await Promise.allSettled([
      service.submit(USER, requestId, "signed"),
      service.submit(USER, requestId, "signed"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(cosign).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url.pathname.endsWith("execute"))).toHaveLength(1);
  });

  for (const executeStatus of [200, 400]) {
    it(`persists execute failures and code/error (HTTP ${executeStatus})`, async () => {
      const execute = executeStatus === 200 ? { status: "Failed", ...failed } : failed;
      const { service, repo } = swapSetup({ execute, executeStatus });
      const { requestId } = await service.build(USER, WALLET, REQUEST);
      expect(await service.submit(USER, requestId, "signed")).toMatchObject({ status: "failed", ...failed });
      expect(repo.records.get(requestId)).toMatchObject({
        status: "failed",
        error: failed.error,
        errorCode: "-2",
      });
    });
  }

  it("keeps unknown outcomes submitted and prevents retrying the signed transaction", async () => {
    const { service, cosign } = swapSetup({ executeError: true });
    const { requestId } = await service.build(USER, WALLET, REQUEST);
    expect(await service.submit(USER, requestId, "signed")).toEqual({ status: "submitted" });
    expect(await service.get(USER, requestId)).toMatchObject({
      status: "submitted",
      error: "Execution outcome unknown",
    });
    await expect(service.submit(USER, requestId, "retry")).rejects.toMatchObject({ reason: "record_used" });
    expect(cosign).toHaveBeenCalledTimes(1);
  });
});

describe("JupiterSwapClient", () => {
  it("uses documented URLs, JSON and optional x-api-key", async () => {
    for (const key of [undefined, "test-key"]) {
      const calls: { url: URL; init?: RequestInit }[] = [];
      const client = new JupiterSwapClient(undefined, key, async (input, init) => {
        calls.push({ url: new URL(input), init });
        return Response.json(preview);
      });
      await client.order({ ...REQUEST, slippageBps: 75 });
      expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://api.jup.ag/swap/v2/order");
      expect(calls[0]!.url.searchParams.get("amount")).toBe("10000000");
      expect(new Headers(calls[0]!.init!.headers).get("x-api-key")).toBe(key ?? null);
      expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    }
  });

  const failures: [string, SwapFetch][] = [
    ["HTTP error", async () => new Response("secret upstream body", { status: 500 })],
    ["empty response", async () => Response.json({})],
    ["invalid JSON", async () => new Response("not JSON")],
    [
      "network error",
      async () => {
        throw new Error("secret upstream error");
      },
    ],
    [
      "timeout",
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        }),
    ],
  ];
  for (const [name, fetcher] of failures) {
    it(`maps ${name} to a sanitized upstream_error`, async () => {
      const client = new JupiterSwapClient(undefined, undefined, fetcher, 5);
      await expect(client.order(REQUEST)).rejects.toMatchObject({
        status: 502,
        code: "upstream_error",
        message: "Jupiter request failed",
      });
    });
  }
});
