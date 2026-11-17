import { expect, it } from "bun:test";
import { HttpSponsorRpc } from "../src/services/sponsor/sponsor-rpc";

it("simulates with exact policy flags and post-state addresses, failing closed on RPC errors", async () => {
  const calls: { jsonrpc: string; id: number; method: string; params: unknown[] }[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { value: { err: null, accounts: [null] } } });
  }) as typeof fetch;
  const rpc = new HttpSponsorRpc("https://rpc.example", fetcher);
  expect(await rpc.simulate("base64", ["payer"])).toEqual({ err: null, accounts: [null] });
  expect(calls).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [
        "base64",
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "processed",
          accounts: { encoding: "base64", addresses: ["payer"] },
        },
      ],
    },
  ]);
  const broken = new HttpSponsorRpc("https://rpc.example", (async () =>
    Response.json({ error: { code: -1 } })) as unknown as typeof fetch);
  await expect(broken.blockHeight()).rejects.toMatchObject({ reason: "simulation" });
  const offline = new HttpSponsorRpc("https://rpc.example", (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch);
  await expect(offline.accounts(["payer"])).rejects.toMatchObject({ reason: "simulation" });
});
