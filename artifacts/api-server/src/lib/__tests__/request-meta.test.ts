import { describe, it, expect } from "vitest";
import { resolveClientIpForGeo, lookupCountry } from "../request-meta";

describe("resolveClientIpForGeo", () => {
  it("uses the leftmost address in X-Forwarded-For (the original client)", () => {
    const req = {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.5, 10.0.0.1" },
      ip: "10.0.0.1",
    };
    expect(resolveClientIpForGeo(req)).toBe("8.8.8.8");
  });

  it("trims whitespace around the leftmost address", () => {
    const req = { headers: { "x-forwarded-for": "  8.8.8.8  , 10.0.0.5" }, ip: "10.0.0.1" };
    expect(resolveClientIpForGeo(req)).toBe("8.8.8.8");
  });

  it("falls back to req.ip when X-Forwarded-For is absent", () => {
    const req = { headers: {}, ip: "203.0.113.7" };
    expect(resolveClientIpForGeo(req)).toBe("203.0.113.7");
  });

  it("falls back to req.ip when X-Forwarded-For is an empty string", () => {
    const req = { headers: { "x-forwarded-for": "" }, ip: "203.0.113.7" };
    expect(resolveClientIpForGeo(req)).toBe("203.0.113.7");
  });

  it("handles X-Forwarded-For arriving as an array (some proxies split it)", () => {
    const req = { headers: { "x-forwarded-for": ["8.8.8.8, 10.0.0.5"] }, ip: "10.0.0.1" };
    expect(resolveClientIpForGeo(req)).toBe("8.8.8.8");
  });

  it("this is exactly the fix for the 'always unknown country' bug: a private trust-proxy hop IP resolves to no country, but the real client IP from X-Forwarded-For does", async () => {
    const req = {
      headers: { "x-forwarded-for": "8.8.8.8, 10.0.0.5" },
      ip: "10.0.0.5", // what req.ip would be if trust-proxy hop count under-counts the real proxy chain
    };
    expect(await lookupCountry(req.ip)).toBeNull();
    expect(await lookupCountry(resolveClientIpForGeo(req))).toBe("US");
  });
});
