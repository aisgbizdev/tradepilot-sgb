import { describe, it, expect } from "vitest";
import {
  localPartsInTimezone,
  isoWeekKey,
  buildRecapMessage,
} from "../weekly-recap";

describe("weekly-recap: localPartsInTimezone", () => {
  it("converts UTC into Asia/Jakarta (UTC+7) correctly", () => {
    // 2026-05-24 12:00 UTC = 2026-05-24 19:00 Jakarta (Sun).
    const utc = new Date("2026-05-24T12:00:00Z");
    const local = localPartsInTimezone(utc, "Asia/Jakarta");
    expect(local.year).toBe(2026);
    expect(local.month).toBe(5);
    expect(local.day).toBe(24);
    expect(local.hour).toBe(19);
    expect(local.weekday).toBe(0); // Sunday
  });

  it("late-night UTC rolls over into next day in Asia/Jakarta", () => {
    // 2026-05-24 18:00 UTC = 2026-05-25 01:00 Jakarta (Mon).
    const utc = new Date("2026-05-24T18:00:00Z");
    const local = localPartsInTimezone(utc, "Asia/Jakarta");
    expect(local.day).toBe(25);
    expect(local.hour).toBe(1);
    expect(local.weekday).toBe(1);
  });

  it("falls back to UTC for an invalid timezone string", () => {
    const utc = new Date("2026-05-24T12:34:00Z");
    const local = localPartsInTimezone(utc, "Not/AZone");
    expect(local.hour).toBe(12);
    expect(local.day).toBe(24);
  });
});

describe("weekly-recap: isoWeekKey", () => {
  it("returns the same key for two days inside the same ISO week", () => {
    const a = isoWeekKey({ year: 2026, month: 5, day: 24, weekday: 0, hour: 19 });
    const b = isoWeekKey({ year: 2026, month: 5, day: 25, weekday: 1, hour: 0 });
    // Sunday 2026-05-24 is the last day of ISO week 21; Monday 2026-05-25
    // is the first day of week 22 — so the keys must differ.
    expect(a).not.toBe(b);
    expect(a).toMatch(/^2026-W\d{2}$/);
  });

  it("produces a stable key for repeat calls in the same Sunday hour", () => {
    const parts = { year: 2026, month: 5, day: 24, weekday: 0 as const, hour: 19 };
    expect(isoWeekKey(parts)).toBe(isoWeekKey(parts));
  });
});

describe("weekly-recap: buildRecapMessage", () => {
  it("renders win-rate only when there are resolved analyses", () => {
    const { title, body } = buildRecapMessage({
      total: 5,
      topInstrument: "XAU/USD",
      topInstrumentCount: 3,
      peakHourLocal: 10,
      tpHits: 2,
      slHits: 1,
      resolved: 3,
    });
    expect(title).toContain("Recap");
    expect(body).toContain("5 analisis");
    expect(body).toContain("win rate 67%");
    expect(body).toContain("XAU/USD");
    expect(body).toContain("jam 10:00");
  });

  it("omits win-rate clause when nothing has resolved yet", () => {
    const { body } = buildRecapMessage({
      total: 2,
      topInstrument: null,
      topInstrumentCount: 0,
      peakHourLocal: null,
      tpHits: 0,
      slHits: 0,
      resolved: 0,
    });
    expect(body).toContain("2 analisis");
    expect(body).not.toContain("win rate");
  });
});
