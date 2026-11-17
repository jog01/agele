import { describe, expect, it } from "bun:test";
import { testApp } from "./helpers";

describe("system routes", () => {
  it("GET /health", async () => {
    const res = await testApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("serves the OpenAPI document", async () => {
    const res = await testApp().request("/openapi.json");
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/v1/tokens/{mint}/candles");
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await testApp().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
