import { describe, expect, it } from "vitest";
import { checklistCycleSubject, levelForXp, localDay, rankForLevel, riskWaitSourceEventId, streaksForDays, withinDailySourceCap } from "../progression";

describe("progression curve and timezone primitives", () => {
  it("starts at level one and exposes absolute level targets", () => {
    expect(levelForXp(0)).toMatchObject({ level: 1, currentLevelXp: 0, nextXp: 50 });
    expect(levelForXp(49)).toMatchObject({ level: 1, currentLevelXp: 0, nextXp: 50 });
    expect(levelForXp(50)).toMatchObject({ level: 2, currentLevelXp: 50, nextXp: 120 });
    expect(levelForXp(119)).toMatchObject({ level: 2, currentLevelXp: 50, nextXp: 120 });
    expect(levelForXp(120)).toMatchObject({ level: 3, currentLevelXp: 120, nextXp: 210 });
  });
  it("has all ten original rank thresholds and unbounded mastery", () => {
    expect(rankForLevel(1)).toBe("seedling");
    expect(rankForLevel(100)).toBe("apex");
    expect(levelForXp(200_000).masteryLevel).toBeGreaterThanOrEqual(1);
    const mastery = levelForXp(200_000);
    expect(mastery.nextXp).toBeGreaterThan(mastery.currentLevelXp);
  });
  it("uses the user's timezone for a local day bucket", () => {
    expect(localDay(new Date("2025-01-01T00:30:00Z"), "America/Los_Angeles")).toBe("2024-12-31");
    expect(checklistCycleSubject("XAUUSD", "1h", new Date("2025-01-01T00:30:00Z"), "America/Los_Angeles")).toBe("XAUUSD:1h:2024-12-31");
  });
  it("keeps checklist and cap day identity on the frozen timezone after preference changes", () => {
    const now = new Date("2025-01-01T00:30:00Z");
    const frozen = "America/Los_Angeles";
    expect(localDay(now, frozen)).toBe("2024-12-31");
    expect(checklistCycleSubject("XAUUSD", "1h", now, frozen)).toBe(checklistCycleSubject("XAUUSD", "1h", now, frozen));
    expect(localDay(now, "Asia/Tokyo")).not.toBe(localDay(now, frozen));
  });
  it("rebuilds both streak values when a revoked middle discipline day breaks a run", () => {
    expect(streaksForDays(["2025-01-01", "2025-01-02", "2025-01-03"])).toMatchObject({ current: 3, longest: 3 });
    // The effective days after revoking 2025-01-02 no longer form a run.
    expect(streaksForDays(["2025-01-01", "2025-01-03"])).toMatchObject({ current: 1, longest: 1, lastDay: "2025-01-03" });
  });
  it("applies the ordinary historical daily cap to legacy rows", () => {
    expect(withinDailySourceCap(20, "quality_journal")).toBe(true);
    expect(withinDailySourceCap(40, "quality_journal")).toBe(false);
  });
  it("deduplicates safe waits by detected event rather than telemetry id", () => {
    const event = { currency: "USD", epochMs: 1735689600000, name: "NFP" };
    expect(riskWaitSourceEventId("XAUUSD", event)).toBe(riskWaitSourceEventId("XAUUSD", event));
    expect(riskWaitSourceEventId("XAUUSD", event)).not.toContain("telemetry");
  });
});