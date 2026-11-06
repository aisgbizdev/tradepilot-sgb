import { describe, it, expect } from "vitest";
import { sessionDueAt, isWeekendUtc, isSessionWeekend, utcDayKey, isValidSession } from "../market-open";

describe("market-open: sessionDueAt", () => {
  it("returns tokyo when now is within 5 min before 00:00 UTC", () => {
    // 23:56 UTC → 4 min before Tokyo open (00:00 next day UTC).
    expect(sessionDueAt(new Date("2026-05-25T23:56:00Z"))).toBe("tokyo");
  });

  it("returns london when now is 07:58 UTC (2 min before 08:00)", () => {
    expect(sessionDueAt(new Date("2026-05-25T07:58:00Z"))).toBe("london");
  });

  it("returns newyork when now is 12:59 UTC (1 min before 13:00)", () => {
    expect(sessionDueAt(new Date("2026-05-25T12:59:00Z"))).toBe("newyork");
  });

  it("returns null in the middle of the trading day", () => {
    expect(sessionDueAt(new Date("2026-05-25T10:00:00Z"))).toBe(null);
  });

  it("returns null exactly at the session open (gap=0 is past)", () => {
    expect(sessionDueAt(new Date("2026-05-25T08:00:00Z"))).toBe(null);
  });

  it("returns null when more than 5 min away from any open", () => {
    expect(sessionDueAt(new Date("2026-05-25T07:50:00Z"))).toBe(null);
  });
});

describe("market-open: isWeekendUtc", () => {
  it("returns true for Saturday UTC", () => {
    expect(isWeekendUtc(new Date("2026-05-23T10:00:00Z"))).toBe(true);
  });
  it("returns true for Sunday UTC", () => {
    expect(isWeekendUtc(new Date("2026-05-24T10:00:00Z"))).toBe(true);
  });
  it("returns false for Monday UTC", () => {
    expect(isWeekendUtc(new Date("2026-05-25T10:00:00Z"))).toBe(false);
  });
});

describe("market-open: isSessionWeekend (target-open gating)", () => {
  it("allows Monday Tokyo reminder fired at Sunday 23:55 UTC", () => {
    // Sunday 23:55 UTC → Tokyo opens at Monday 00:00 UTC.
    // Naive isWeekendUtc(now) would block this; isSessionWeekend should not.
    const sundayLateUtc = new Date("2026-05-24T23:55:00Z");
    expect(isWeekendUtc(sundayLateUtc)).toBe(true);
    expect(isSessionWeekend(sundayLateUtc, "tokyo")).toBe(false);
  });

  it("blocks a London reminder whose open lands on Sunday UTC", () => {
    // Sunday 07:55 UTC → London open is Sunday 08:00 UTC, still weekend.
    const sundayMorningUtc = new Date("2026-05-24T07:55:00Z");
    expect(isSessionWeekend(sundayMorningUtc, "london")).toBe(true);
  });

  it("allows a London reminder on a weekday morning", () => {
    const monMorningUtc = new Date("2026-05-25T07:55:00Z");
    expect(isSessionWeekend(monMorningUtc, "london")).toBe(false);
  });
});

describe("market-open: utcDayKey", () => {
  it("formats as YYYY-MM-DD with zero-padding", () => {
    expect(utcDayKey(new Date("2026-01-05T07:00:00Z"))).toBe("2026-01-05");
  });
});

describe("market-open: isValidSession", () => {
  it("accepts the three known sessions", () => {
    expect(isValidSession("tokyo")).toBe(true);
    expect(isValidSession("london")).toBe(true);
    expect(isValidSession("newyork")).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isValidSession("sydney")).toBe(false);
    expect(isValidSession("")).toBe(false);
  });
});
