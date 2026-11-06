import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "../db";
import { mobileOauthTransactions, users } from "@workspace/db/schema";
import { inArray, like } from "drizzle-orm";
import {
  isAllowedMobileRedirectUri,
  isValidCodeChallenge,
  createMobileTransaction,
  findPendingMobileTransaction,
  getMobileTransactionById,
  issueMobileExchangeCode,
  consumeMobileExchangeCode,
  buildMobileCallbackUrl,
} from "../mobile-oauth";

const RUN_ID = randomBytes(4).toString("hex");
const REDIRECT_URI = "id.tradepilot.app://auth/callback";
const EMAIL_PREFIX = `mobile-oauth-test-${RUN_ID}`;
const seededIds: number[] = [];
const seededUserIds: number[] = [];

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function seedUser(): Promise<number> {
  const email = `${EMAIL_PREFIX}-${randomBytes(4).toString("hex")}@example.test`;
  const passwordHash = await bcrypt.hash("not-used", 4);
  const securityAnswerHash = await bcrypt.hash("answer", 4);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash,
      displayName: `Mobile OAuth Test ${RUN_ID}`,
      securityQuestion: "test?",
      securityAnswerHash,
    })
    .returning({ id: users.id });
  seededUserIds.push(row!.id);
  return row!.id;
}

const savedEnv = process.env["MOBILE_OAUTH_REDIRECT_URIS"];
beforeAll(() => {
  process.env["MOBILE_OAUTH_REDIRECT_URIS"] = REDIRECT_URI;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env["MOBILE_OAUTH_REDIRECT_URIS"];
  else process.env["MOBILE_OAUTH_REDIRECT_URIS"] = savedEnv;
  if (seededIds.length) {
    await db.delete(mobileOauthTransactions).where(inArray(mobileOauthTransactions.id, seededIds));
  }
  await db.delete(mobileOauthTransactions).where(like(mobileOauthTransactions.redirectUri, `%${RUN_ID}%`));
  if (seededUserIds.length) {
    await db.delete(users).where(inArray(users.id, seededUserIds));
  }
  await db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
});

describe("isAllowedMobileRedirectUri", () => {
  it("accepts an exact match from the allowlist", () => {
    expect(isAllowedMobileRedirectUri(REDIRECT_URI)).toBe(true);
  });
  it("rejects a prefix/substring match — no startsWith semantics", () => {
    expect(isAllowedMobileRedirectUri(`${REDIRECT_URI}.evil.com`)).toBe(false);
    expect(isAllowedMobileRedirectUri("id.tradepilot.app://auth/callback/extra")).toBe(false);
  });
  it("rejects an unrelated scheme", () => {
    expect(isAllowedMobileRedirectUri("evil://auth/callback")).toBe(false);
  });
  it("rejects non-string / empty input", () => {
    expect(isAllowedMobileRedirectUri(undefined)).toBe(false);
    expect(isAllowedMobileRedirectUri("")).toBe(false);
    expect(isAllowedMobileRedirectUri(123)).toBe(false);
  });
});

describe("isValidCodeChallenge", () => {
  it("accepts a real base64url(SHA-256(x)) shape (43 chars)", () => {
    expect(isValidCodeChallenge(s256("some-verifier"))).toBe(true);
  });
  it("rejects the wrong length", () => {
    expect(isValidCodeChallenge("tooshort")).toBe(false);
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
  });
  it("rejects characters outside the base64url alphabet", () => {
    expect(isValidCodeChallenge("+".repeat(43))).toBe(false);
    expect(isValidCodeChallenge("=".repeat(43))).toBe(false);
  });
  it("rejects non-string input", () => {
    expect(isValidCodeChallenge(undefined)).toBe(false);
    expect(isValidCodeChallenge(null)).toBe(false);
  });
});

describe("createMobileTransaction + findPendingMobileTransaction", () => {
  it("round-trips: the raw state finds the transaction back, an unrelated state doesn't", async () => {
    const verifier = `verifier-${RUN_ID}`;
    const { id, state } = await createMobileTransaction({
      provider: "facebook",
      redirectUri: `${REDIRECT_URI}?run=${RUN_ID}`,
      codeChallenge: s256(verifier),
    });
    seededIds.push(id);

    const found = await findPendingMobileTransaction(state);
    expect(found?.id).toBe(id);
    expect(found?.provider).toBe("facebook");

    expect(await findPendingMobileTransaction("not-a-real-state")).toBeNull();
    expect(await findPendingMobileTransaction(null)).toBeNull();
  });

  it("stores the TikTok provider-side code verifier alongside the mobile challenge", async () => {
    const verifier = `verifier-${RUN_ID}-tiktok`;
    const { id, state } = await createMobileTransaction({
      provider: "tiktok",
      redirectUri: `${REDIRECT_URI}?run=${RUN_ID}`,
      codeChallenge: s256(verifier),
      providerCodeVerifier: "tiktok-provider-verifier",
    });
    seededIds.push(id);
    const found = await findPendingMobileTransaction(state);
    expect(found?.providerCodeVerifier).toBe("tiktok-provider-verifier");
  });

  it("a transaction that already has an exchange code issued no longer counts as pending", async () => {
    const verifier = `verifier-${RUN_ID}-issued`;
    const { id, state } = await createMobileTransaction({
      provider: "facebook",
      redirectUri: `${REDIRECT_URI}?run=${RUN_ID}`,
      codeChallenge: s256(verifier),
    });
    seededIds.push(id);
    const userId = await seedUser();
    await issueMobileExchangeCode(id, userId, false);
    expect(await findPendingMobileTransaction(state)).toBeNull();
  });
});

describe("issueMobileExchangeCode + consumeMobileExchangeCode", () => {
  async function seedTransaction(codeChallenge: string) {
    const { id } = await createMobileTransaction({
      provider: "facebook",
      redirectUri: `${REDIRECT_URI}?run=${RUN_ID}`,
      codeChallenge,
    });
    seededIds.push(id);
    return id;
  }

  it("consumes successfully with the right verifier, and never twice", async () => {
    const verifier = `verifier-${RUN_ID}-ok`;
    const txId = await seedTransaction(s256(verifier));
    const userId = await seedUser();
    const code = await issueMobileExchangeCode(txId, userId, true);

    const first = await consumeMobileExchangeCode(code, verifier);
    expect(first).toEqual({ ok: true, userId, isNewUser: true });

    const second = await consumeMobileExchangeCode(code, verifier);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects the wrong verifier without consuming the code", async () => {
    const verifier = `verifier-${RUN_ID}-wrong`;
    const txId = await seedTransaction(s256(verifier));
    const userId = await seedUser();
    const code = await issueMobileExchangeCode(txId, userId, false);

    const bad = await consumeMobileExchangeCode(code, "not-the-right-verifier");
    expect(bad).toEqual({ ok: false, reason: "bad_verifier" });

    // Still usable afterward with the correct verifier — a wrong guess
    // must not burn the one-time code.
    const good = await consumeMobileExchangeCode(code, verifier);
    expect(good.ok).toBe(true);
  });

  it("rejects an unknown code", async () => {
    const outcome = await consumeMobileExchangeCode("not-a-real-code", "whatever");
    expect(outcome).toEqual({ ok: false, reason: "not_found" });
  });

  it("rejects an expired code", async () => {
    const verifier = `verifier-${RUN_ID}-expired`;
    const txId = await seedTransaction(s256(verifier));
    const userId = await seedUser();
    const code = await issueMobileExchangeCode(txId, userId, false);
    // Force it into the past — issueMobileExchangeCode's real TTL is 90s,
    // too slow to actually wait out in a test.
    await db
      .update(mobileOauthTransactions)
      .set({ codeExpiresAt: new Date(Date.now() - 1000) })
      .where(inArray(mobileOauthTransactions.id, [txId]));

    const outcome = await consumeMobileExchangeCode(code, verifier);
    expect(outcome).toEqual({ ok: false, reason: "expired" });
  });

  it("two simultaneous exchange attempts for the same code: exactly one wins", async () => {
    const verifier = `verifier-${RUN_ID}-race`;
    const txId = await seedTransaction(s256(verifier));
    const userId = await seedUser();
    const code = await issueMobileExchangeCode(txId, userId, false);

    const [a, b] = await Promise.all([
      consumeMobileExchangeCode(code, verifier),
      consumeMobileExchangeCode(code, verifier),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.reason === "already_used")).toHaveLength(1);
  });
});

describe("getMobileTransactionById", () => {
  it("returns the row by id, and null for an unknown id", async () => {
    const { id } = await createMobileTransaction({
      provider: "tiktok",
      redirectUri: `${REDIRECT_URI}?run=${RUN_ID}`,
      codeChallenge: s256(`verifier-${RUN_ID}-byid`),
    });
    seededIds.push(id);
    expect((await getMobileTransactionById(id))?.id).toBe(id);
    expect(await getMobileTransactionById(999_999_999)).toBeNull();
  });
});

describe("buildMobileCallbackUrl", () => {
  it("builds a code URL and an error URL off the same redirect_uri", () => {
    expect(buildMobileCallbackUrl(REDIRECT_URI, { code: "abc123" })).toBe(`${REDIRECT_URI}?code=abc123`);
    expect(buildMobileCallbackUrl(REDIRECT_URI, { error: "access_denied" })).toBe(
      `${REDIRECT_URI}?error=access_denied`,
    );
  });
});
