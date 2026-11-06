// Unit tests for verifyAppleIdentityToken's real jwtVerify/JWKS logic.
//
// auth.test.ts mocks this entire module (../../lib/apple-oauth) wholesale
// so the route tests can drive any Apple profile without touching the
// network — which means those tests never exercise the actual signature
// verification, and would not have caught the ES256/RS256 algorithm bug
// (Apple signs identity tokens with RS256; only the client-secret JWT this
// module signs itself, for the authorization-code exchange, uses ES256).
//
// These tests call the real, unmocked function against a synthetic RSA
// keypair — via __setAppleJwksForTesting, since jose's Node runtime fetches
// the remote JWKS with node:https directly, not the global `fetch`, so it
// can't be intercepted the usual way.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import {
  verifyAppleIdentityToken,
  __setAppleJwksForTesting,
  APPLE_ISSUER,
} from "../apple-oauth";

const AUDIENCE = "id.tradepilot.app";
const KID = "test-rsa-kid";
const RAW_NONCE = "unit-test-raw-nonce";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

let rsaPrivateKey: KeyLike;

async function signToken(opts: {
  alg?: string;
  key?: KeyLike | Uint8Array;
  kid?: string;
  sub?: string;
  aud?: string;
  iss?: string;
  nonce?: string;
  emailVerified?: boolean | string;
  expSecondsFromNow?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: "user@example.test",
    email_verified: opts.emailVerified ?? true,
    nonce: opts.nonce ?? sha256Hex(RAW_NONCE),
  })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID })
    .setIssuer(opts.iss ?? APPLE_ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? "000123.abcdef0123456789.0123")
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSecondsFromNow ?? 300))
    .sign(opts.key ?? rsaPrivateKey);
}

describe("verifyAppleIdentityToken (real jwtVerify + JWKS, no mocks)", () => {
  const ENV_KEYS = ["APPLE_ALLOWED_CLIENT_IDS"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env["APPLE_ALLOWED_CLIENT_IDS"] = AUDIENCE;

    const { publicKey, privateKey } = await generateKeyPair("RS256");
    rsaPrivateKey = privateKey;
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = KID;
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    // Matches exactly what Apple's real https://appleid.apple.com/auth/keys
    // returns: RSA keys, alg RS256 (verified against the live endpoint
    // while diagnosing the original bug report).
    __setAppleJwksForTesting(createLocalJWKSet({ keys: [publicJwk] }));
  });

  afterAll(() => {
    __setAppleJwksForTesting(null);
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("accepts a genuine RS256-signed identity token — this is how Apple actually signs them", async () => {
    const token = await signToken({});
    const profile = await verifyAppleIdentityToken(token, RAW_NONCE);
    expect(profile.appleId).toBe("000123.abcdef0123456789.0123");
    expect(profile.email).toBe("user@example.test");
    expect(profile.emailVerified).toBe(true);
    expect(profile.audience).toBe(AUDIENCE);
  });

  it("rejects a token signed with an algorithm other than RS256", async () => {
    // A shared-secret HS256 token: still parses as a JWT, but jose's
    // `algorithms: ["RS256"]` restriction must refuse it outright.
    const token = await signToken({
      alg: "HS256",
      key: new TextEncoder().encode("not-a-real-apple-secret-shh"),
    });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("rejects a wrong issuer", async () => {
    const token = await signToken({ iss: "https://not-apple.example.test" });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("rejects an audience outside the configured allowlist", async () => {
    const token = await signToken({ aud: "com.someone.else" });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ expSecondsFromNow: -3600 });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("rejects when the nonce claim doesn't match SHA-256(rawNonce)", async () => {
    const token = await signToken({ nonce: sha256Hex("a-different-raw-nonce") });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("rejects email_verified=false when an email claim is present", async () => {
    const token = await signToken({ emailVerified: false });
    await expect(verifyAppleIdentityToken(token, RAW_NONCE)).rejects.toThrow();
  });

  it("accepts Apple's string \"true\" form of email_verified, not just the boolean", async () => {
    const token = await signToken({ emailVerified: "true" });
    const profile = await verifyAppleIdentityToken(token, RAW_NONCE);
    expect(profile.emailVerified).toBe(true);
  });
});
