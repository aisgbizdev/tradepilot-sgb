import { describe, expect, it } from "vitest";

import {
  GUIDE_IDS,
  completedGuideIdsFromLedger,
  startEvidenceSchema,
} from "../progression";

describe("progression guide evidence contract", () => {
  it.each(["personal-progression", "timeframe-risk-map", "history-performance", "data-handling", "fomo", "patience"] as const)(
    "accepts completion evidence for %s",
    (guideId) => {
      expect(GUIDE_IDS).toContain(guideId);
      expect(
        startEvidenceSchema.safeParse({
          source: "guide_completion",
          guideId,
        }).success,
      ).toBe(true);
    },
  );

  it("returns only valid, non-revoked guide completions", () => {
    expect(completedGuideIdsFromLedger([
      {
        id: 1,
        source: "guide_completion",
        sourceEventId: "guide:how-ai-works",
        xp: 50,
        correctionOfLedgerId: null,
      },
      {
        id: 2,
        source: "guide_completion",
        sourceEventId: "guide:analysis-workflow",
        xp: 50,
        correctionOfLedgerId: null,
      },
      {
        id: 3,
        source: "admin_correction",
        sourceEventId: "correction:1",
        xp: -50,
        correctionOfLedgerId: 1,
      },
      {
        id: 4,
        source: "quality_journal",
        sourceEventId: "guide:feature-map",
        xp: 50,
        correctionOfLedgerId: null,
      },
    ])).toEqual(["analysis-workflow"]);
  });
});