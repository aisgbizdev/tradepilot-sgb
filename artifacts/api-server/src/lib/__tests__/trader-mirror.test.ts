import { describe, it, expect } from "vitest";
import {
  sessionBucket,
  timeBucket,
  buildHighlights,
  MIN_SAMPLE,
  type TraderMirrorInsights,
} from "../trader-mirror";

describe("trader-mirror: sessionBucket", () => {
  it("buckets UTC hours into the four FX session windows", () => {
    expect(sessionBucket(new Date("2026-05-24T03:00:00Z"))).toBe("asia");
    expect(sessionBucket(new Date("2026-05-24T08:00:00Z"))).toBe("london");
    expect(sessionBucket(new Date("2026-05-24T15:00:00Z"))).toBe("newyork");
    expect(sessionBucket(new Date("2026-05-24T22:00:00Z"))).toBe("off");
  });
});

describe("trader-mirror: timeBucket", () => {
  it("uses the user's local timezone to bucket morning/midday/afternoon/late", () => {
    // 04:00 UTC = 11:00 Jakarta (midday)
    expect(timeBucket(new Date("2026-05-24T04:00:00Z"), "Asia/Jakarta")).toBe(
      "midday",
    );
    // 23:00 UTC = 06:00 next-day Jakarta (morning)
    expect(timeBucket(new Date("2026-05-23T23:00:00Z"), "Asia/Jakarta")).toBe(
      "morning",
    );
    // 18:00 UTC = 01:00 Jakarta (late)
    expect(timeBucket(new Date("2026-05-24T18:00:00Z"), "Asia/Jakarta")).toBe(
      "late",
    );
  });

  it("falls back to UTC bucketing for an invalid timezone", () => {
    expect(timeBucket(new Date("2026-05-24T08:00:00Z"), "Not/AZone")).toBe(
      "morning",
    );
  });
});

function gatedAll(): TraderMirrorInsights {
  return {
    windowDays: null,
    totalResolved: 2,
    overallGated: true,
    sessions: { gated: true, reason: "need_more_data", need: 5, have: 2 },
    instruments: { gated: true, reason: "need_more_data", need: 5, have: 2 },
    timing: { gated: true, reason: "need_more_data", need: 5, have: 2 },
    postLoss: { gated: true, reason: "need_more_data", need: 5, have: 0 },
    exitDiscipline: { gated: true, reason: "need_more_data", need: 5, have: 0 },
  };
}

describe("trader-mirror: buildHighlights", () => {
  it("returns an empty list when every category is gated", () => {
    expect(buildHighlights(gatedAll())).toEqual([]);
  });

  it("includes a best-session highlight when one is available", () => {
    const insights: TraderMirrorInsights = {
      ...gatedAll(),
      overallGated: false,
      sessions: {
        gated: false,
        data: {
          best: {
            key: "london",
            total: 12,
            wins: 9,
            winRate: 0.75,
            avgPnlPercent: 1.4,
          },
          worst: null,
          all: [],
        },
      },
    };
    const hl = buildHighlights(insights);
    expect(hl.length).toBeGreaterThan(0);
    expect(hl[0]!.en).toContain("London");
    expect(hl[0]!.id_).toContain("London");
    expect(hl[0]!.en).toContain("75%");
  });

  it("flags revenge-trade tilt when post-loss win rate drops by 10+ points", () => {
    const insights: TraderMirrorInsights = {
      ...gatedAll(),
      overallGated: false,
      postLoss: {
        gated: false,
        data: {
          afterLossWinRate: 0.3,
          baselineWinRate: 0.55,
          delta: -0.25,
          sample: 8,
        },
      },
    };
    const hl = buildHighlights(insights);
    const tilt = hl.find((h) => h.id === "post-loss-tilt");
    expect(tilt).toBeDefined();
    expect(tilt!.en).toContain("25");
    expect(tilt!.id_).toContain("revenge");
  });

  it("flags exit-too-early when capture ratio is below 60%", () => {
    const insights: TraderMirrorInsights = {
      ...gatedAll(),
      overallGated: false,
      exitDiscipline: {
        gated: false,
        data: {
          avgProjectedPct: 2.0,
          avgCapturedPct: 0.6,
          captureRatio: 0.3,
          sample: 7,
        },
      },
    };
    const hl = buildHighlights(insights);
    const exit = hl.find((h) => h.id === "exit-early");
    expect(exit).toBeDefined();
    expect(exit!.en).toContain("30%");
  });
});

describe("trader-mirror: MIN_SAMPLE", () => {
  it("uses the documented minimum sample sizes", () => {
    // Locking the thresholds here so any future change is intentional —
    // these numbers are part of the UX contract ("Need more data" copy).
    expect(MIN_SAMPLE.overall).toBeGreaterThanOrEqual(5);
    expect(MIN_SAMPLE.session).toBeGreaterThanOrEqual(5);
    expect(MIN_SAMPLE.instrument).toBeGreaterThanOrEqual(5);
    expect(MIN_SAMPLE.postLoss).toBeGreaterThanOrEqual(5);
    expect(MIN_SAMPLE.exitDiscipline).toBeGreaterThanOrEqual(5);
  });
});
