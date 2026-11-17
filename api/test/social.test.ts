import { describe, expect, it } from "bun:test";
import { SOL, testApp } from "./helpers";

describe("social controller", () => {
  const app = testApp();

  it("ranks the leaderboard by PnL", async () => {
    const res = await app.request("/v1/leaderboard?window=7d&limit=10");
    const body = (await res.json()) as { window: string; entries: { rank: number; pnlUsd: number }[] };
    expect(body.window).toBe("7d");
    expect(body.entries).toHaveLength(10);
    for (let i = 1; i < body.entries.length; i++) {
      expect(body.entries[i - 1]!.pnlUsd).toBeGreaterThanOrEqual(body.entries[i]!.pnlUsd);
      expect(body.entries[i]!.rank).toBe(i + 1);
    }
  });

  it("returns comments for a known token and 404s otherwise", async () => {
    expect((await app.request(`/v1/tokens/${SOL}/comments`)).status).toBe(200);
    expect((await app.request("/v1/tokens/11111111111111111111111111111111/comments")).status).toBe(404);
  });
});
