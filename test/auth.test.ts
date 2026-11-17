import { describe, expect, it } from "bun:test";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { env } from "../src/config/env";
import { unauthorized } from "../src/lib/errors";
import { createAuthVerifier, PrivyAuthVerifier } from "../src/services/auth.service";
import type { UserService } from "../src/services/user.service";
import { testApp } from "./helpers";

const fakeUsers = {
  ensureUser: async ({ privyDid }: { privyDid: string }) => ({
    id: "00000000-0000-0000-0000-000000000001",
    privyDid,
    walletAddress: null,
    handle: null,
    wallets: [],
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
    expect(await res.json()).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
      privyDid: "did:privy:abc",
      handle: null,
      walletAddress: null,
      wallets: [],
    });
  });

  it("returns only the agreed wallet fields", async () => {
    const wallet = {
      address: "solana-wallet",
      chainType: "solana",
      walletClientType: "privy",
      privyWalletId: "wallet-id",
      isPrimary: true,
    };
    const linkedApp = testApp({
      auth: { verify: async () => ({ privyDid: "did:privy:abc", sessionId: "s1" }) },
      users: {
        ensureUser: async () => ({
          ...(await fakeUsers.ensureUser({ privyDid: "did:privy:abc", sessionId: "s1" })),
          walletAddress: wallet.address,
          wallets: [{ ...wallet, id: "internal", userId: "internal" }],
        }),
      } as unknown as UserService,
    });
    const res = await linkedApp.request("/v1/me", { headers: { authorization: "Bearer good" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
      privyDid: "did:privy:abc",
      handle: null,
      walletAddress: wallet.address,
      wallets: [wallet],
    });
  });

  it("returns 503 when auth is not configured", async () => {
    const appId = env.PRIVY_APP_ID;
    let auth: ReturnType<typeof createAuthVerifier>;
    try {
      env.PRIVY_APP_ID = undefined;
      auth = createAuthVerifier();
    } finally {
      env.PRIVY_APP_ID = appId;
    }
    const res = await testApp({ auth }).request("/v1/me", { headers: { authorization: "Bearer token" } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "auth_not_configured" } });
  });
});

describe("Privy access token verification", () => {
  it("verifies pinned keys and JWKS and rejects invalid tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [{ ...jwk, kid: "test", alg: "ES256" }] }),
    });
    const token = (audience = "app", expiration = "1h") =>
      new SignJWT({ sid: "session" })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "test" })
        .setIssuer("privy.io")
        .setSubject("did:privy:test")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiration)
        .sign(privateKey);
    try {
      for (const verifier of [
        new PrivyAuthVerifier("app", await exportSPKI(publicKey)),
        new PrivyAuthVerifier("app", undefined, new URL("/jwks", server.url)),
      ]) {
        expect(await verifier.verify(await token())).toEqual({
          privyDid: "did:privy:test",
          sessionId: "session",
        });
        for (const invalid of [await token("wrong"), await token("app", "-1h"), "garbage"]) {
          await expect(verifier.verify(invalid)).rejects.toMatchObject({ status: 401 });
        }
      }
    } finally {
      server.stop(true);
    }
  });
});
