import { describe, expect, it } from "bun:test";
import { SOL, testApp } from "./helpers";

describe("tokens controller", () => {
  const app = testApp();

  it("lists trending tokens", async () => {
    const res = await app.request("/v1/tokens/trending?limit=3");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: unknown[] };
    expect(body.tokens).toHaveLength(3);
  });

  it("returns a token by mint", async () => {
    const res = await app.request(`/v1/tokens/${SOL}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ symbol: "SOL", decimals: 9 });
  });

  it("404s on an unknown mint", async () => {
    const res = await app.request("/v1/tokens/11111111111111111111111111111111");
    expect(res.status).toBe(404);
  });

  it("validates query params", async () => {
    const res = await app.request(`/v1/tokens/${SOL}/candles?interval=7m`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "validation_error" } });
  });

  it("returns ordered candles", async () => {
    const res = await app.request(`/v1/tokens/${SOL}/candles?interval=1h&limit=24`);
    const { candles } = (await res.json()) as { candles: { time: number; high: number; low: number }[] };
    expect(candles).toHaveLength(24);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i]!.time - candles[i - 1]!.time).toBe(3600);
      expect(candles[i]!.high).toBeGreaterThanOrEqual(candles[i]!.low);
    }
  });

  it("returns recent trades", async () => {
    const res = await app.request(`/v1/tokens/${SOL}/trades?limit=5`);
    const { trades } = (await res.json()) as { trades: { mint: string }[] };
    expect(trades).toHaveLength(5);
    expect(trades.every((t) => t.mint === SOL)).toBe(true);
  });
});
