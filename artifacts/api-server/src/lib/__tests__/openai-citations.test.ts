// Tests for `validateFundamentalCitations` and the retry/throw path
// in `generateAnalysis` (citation grounding).
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateAnalysis,
  openai,
  validateFundamentalCitations,
} from "../openai";
import type { NewsItem } from "../news";
import type { CalendarEvent } from "../calendar";

function newsItem(title: string): NewsItem {
  return {
    id: `mock-${title}`,
    title,
    summary: "",
    source: "Newsmaker.id",
    url: null,
    publishedAt: "2026-04-30T10:00:00Z",
  };
}

function calEvent(event: string, currency = "USD"): CalendarEvent {
  return {
    date: "2026-04-30",
    time: "12:00",
    epochMs: Date.UTC(2026, 3, 30, 12, 0, 0, 0),
    currency,
    event,
    impact: "★★★",
    actual: null,
    forecast: null,
    previous: null,
  };
}

describe("validateFundamentalCitations", () => {
  it("ok when snapshot is empty AND citations are empty", () => {
    const r = validateFundamentalCitations(
      { newsTitles: [], calendarEvents: [] },
      { newsItems: [], calendarEvents: [] },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects fabricated citations against an empty snapshot", () => {
    const r = validateFundamentalCitations(
      { newsTitles: ["Made-up Fed speech"], calendarEvents: [] },
      { newsItems: [], calendarEvents: [] },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/fabricated/i);
  });

  // The grounding gate intentionally tolerates an empty / missing
  // `fundamentalCitations` object even when the snapshot is non-empty:
  // the model is allowed to decide "no material fundamental catalyst"
  // for this specific setup/timeframe. We only hard-fail on
  // *fabricated* citations — see the `validateFundamentalCitations`
  // implementation in lib/openai.ts for the rationale.
  it("accepts empty citations even when snapshot is non-empty (model opted out of fundamentals)", () => {
    const r = validateFundamentalCitations(
      { newsTitles: [], calendarEvents: [] },
      {
        newsItems: [newsItem("Gold rallies on Fed pause")],
        calendarEvents: [calEvent("FOMC statement")],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a missing citations object when snapshot is non-empty (no citations is the same as opting out)", () => {
    const r = validateFundamentalCitations(undefined, {
      newsItems: [newsItem("Gold rallies on Fed pause")],
      calendarEvents: [],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts a cited news title that substring-matches the snapshot", () => {
    const r = validateFundamentalCitations(
      { newsTitles: ["Gold rallies"], calendarEvents: [] },
      {
        newsItems: [newsItem("Gold rallies on Fed pause")],
        calendarEvents: [],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a cited calendar event that substring-matches", () => {
    const r = validateFundamentalCitations(
      { newsTitles: [], calendarEvents: ["FOMC statement USD"] },
      {
        newsItems: [],
        calendarEvents: [calEvent("FOMC statement", "USD")],
      },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a cited news title that does not appear in the snapshot", () => {
    const r = validateFundamentalCitations(
      { newsTitles: ["Completely unrelated story about cats"], calendarEvents: [] },
      {
        newsItems: [newsItem("Gold rallies on Fed pause")],
        calendarEvents: [],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/News citation/i);
  });

  it("rejects a cited calendar event that does not appear in the snapshot", () => {
    const r = validateFundamentalCitations(
      { newsTitles: [], calendarEvents: ["ECB press conference EUR"] },
      {
        newsItems: [],
        calendarEvents: [calEvent("FOMC statement", "USD")],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Calendar citation/i);
  });
});

/**
 * Integration-flavored tests against `generateAnalysis` itself: we
 * stub `openai.chat.completions.create` to return *fabricated*
 * citations (titles/events that don't appear in the snapshot) and
 * assert that `generateAnalysis` THROWS rather than silently accepting
 * them. Empty citations against a non-empty snapshot are intentionally
 * allowed (the model may legitimately decide fundamentals aren't
 * material) — only fabricated citations are a hard fail.
 */
describe("generateAnalysis — hard grounding gate", () => {
  function ungroundedBeginnerResponse() {
    // Schema-valid beginner output with FABRICATED citations against
    // the snapshot passed in by the test — must trigger the grounding
    // retry and then throw when the retry also returns fabricated
    // citations.
    return {
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              marketCondition: "trending_up",
              riskLevel: "medium",
              confidenceMin: 60,
              confidenceMax: 75,
              tradingBias: "bullish",
              opportunity: "Generic upside opportunity.",
              risk: "Generic downside risk.",
              mainScenario:
                "Pasar kemungkinan melanjutkan kenaikan pada timeframe 30m.",
              alternativeScenario:
                "Jika gagal break, pasar dapat berbalik turun pada 30m.",
              whyReason: "Tren sejajar pada 30m.",
              failureConditions: "Close 30m di bawah swing low.",
              tradePlan: {
                preferredSide: "wait",
                buy: {
                  entryZone: "2300-2310",
                  stopLoss: "2290",
                  takeProfit1: "2330",
                  takeProfit2: "2350",
                  riskRewardRatio: "1:2",
                  rationale: "Stub buy plan.",
                },
                sell: {
                  entryZone: "2360-2370",
                  stopLoss: "2380",
                  takeProfit1: "2340",
                  takeProfit2: "2320",
                  riskRewardRatio: "1:2",
                  rationale: "Stub sell plan.",
                },
              },
              fundamentalCitations: {
                newsTitles: ["Totally made-up headline about silver mining"],
                calendarEvents: ["Fictional ECB press conference EUR"],
              },
            }),
          },
          finish_reason: "stop",
        },
      ],
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the model returns ungrounded citations even after the corrective retry", async () => {
    const createSpy = vi
      .spyOn(openai.chat.completions, "create")
      // Both the first attempt and the retry return ungrounded
      // citations against a non-empty snapshot.
      .mockResolvedValue(ungroundedBeginnerResponse() as never);

    await expect(
      generateAnalysis(
        "XAU/USD",
        "30m",
        "beginner",
        undefined,
        undefined,
        {
          newsItems: [newsItem("Gold rallies on Fed pause")],
          calendarEvents: [calEvent("FOMC statement", "USD")],
        },
        2305,
      ),
    ).rejects.toThrow(/grounding failed/i);

    // Two calls — the original + the corrective retry — then we throw.
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
