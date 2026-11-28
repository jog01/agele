import { verifyAccessToken } from "@privy-io/node";
import { createRemoteJWKSet } from "jose";
import { env } from "../config/env";
import { AppError, unauthorized } from "../lib/errors";

export interface AuthClaims {
  privyDid: string;
  sessionId: string;
}

export interface AuthVerifier {
  verify(accessToken: string): Promise<AuthClaims>;
}

interface SessionAuthVerifier extends AuthVerifier {
  verifySession(accessToken: string): Promise<AuthClaims & { expiresAt: number }>;
}

/** Verifies Privy access tokens (ES256 JWTs) against the app's JWKS or a pinned key. */
export class PrivyAuthVerifier implements SessionAuthVerifier {
  private readonly key;

  constructor(
    private readonly appId: string,
    verificationKey?: string,
    jwksUrl = new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
  ) {
    this.key = verificationKey || createRemoteJWKSet(jwksUrl);
  }

  async verify(accessToken: string): Promise<AuthClaims> {
    const { privyDid, sessionId } = await this.verifySession(accessToken);
    return { privyDid, sessionId };
  }

  async verifySession(accessToken: string) {
    try {
      const claims = await verifyAccessToken({
        access_token: accessToken,
        app_id: this.appId,
        verification_key: this.key,
      });
      return { privyDid: claims.user_id, sessionId: claims.session_id, expiresAt: claims.expiration * 1000 };
    } catch {
      throw unauthorized("Invalid access token");
    }
  }
}

class UnconfiguredAuthVerifier implements SessionAuthVerifier {
  async verify(): Promise<AuthClaims> {
    return this.verifySession();
  }

  async verifySession(): Promise<never> {
    throw new AppError(503, "auth_not_configured", "PRIVY_APP_ID is not set on the API");
  }
}

export function createAuthVerifier(): SessionAuthVerifier {
  return env.PRIVY_APP_ID
    ? new PrivyAuthVerifier(env.PRIVY_APP_ID, env.PRIVY_VERIFICATION_KEY)
    : new UnconfiguredAuthVerifier();
}
