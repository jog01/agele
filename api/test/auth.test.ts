import { describe, expect, it } from "bun:test";
import { unauthorized } from "../src/lib/errors";
import type { UserService } from "../src/services/user.service";
import { testApp } from "./helpers";

const fakeUsers = {
  ensureUser: async ({ privyDid }: { privyDid: string }) => ({
    id: "00000000-0000-0000-0000-000000000001",
    privyDid,
    walletAddress: null,
    handle: null,
  }),
} as unknown as UserService;

const app = testApp({
  users: fakeUsers,
  auth: {
    verify: async (token) => {
      if (token !== "good") throw unauthorized("Invalid access token");
      return { privyDid: "did:privy:abc", sessionId: "s1" };
    },
  },
});

describe("GET /v1/me", () => {
  it("rejects missing token", async () => {
    expect((await app.request("/v1/me")).status).toBe(401);
  });

  it("rejects bad token", async () => {
    const res = await app.request("/v1/me", { headers: { authorization: "Bearer bad" } });
    expect(res.status).toBe(401);
  });

  it("returns the user for a valid token", async () => {
    const res = await app.request("/v1/me", { headers: { authorization: "Bearer good" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ privyDid: "did:privy:abc" });
  });
});
