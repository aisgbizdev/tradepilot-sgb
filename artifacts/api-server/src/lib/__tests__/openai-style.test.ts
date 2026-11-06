// Golden tests for the Indonesian-native style guide block injected
// into every analysis user-message. We don't assert specific phrasing
// of the analogies (those can evolve) — only that the guide block is
// present, applies to both BEGINNER and PRO modes, and continues to
// forbid emoji and lo/gw casual register.
import { afterEach, describe, expect, it, vi } from "vitest";

import { generateAnalysis, openai } from "../openai";

afterEach(() => {
  vi.restoreAllMocks();
});

async function runAndCaptureUserMessage(
  mode: "beginner" | "pro",
  role: "user" | "system" = "user",
  instrument = "XAU/USD",
  timeframe = "1H",
): Promise<string> {
  const captured: string[] = [];
  vi.spyOn(openai.chat.completions, "create").mockImplementation((async (
    params: any,
  ) => {
      const userMsg = params.messages.find(
        (m: { role: string }) => m.role === role,
      );
      if (userMsg) captured.push(userMsg.content as string);
      // Minimum-viable beginner-shaped response so generateAnalysis
      // parses without throwing. Field set covers both modes (extras
      // are tolerated by zod's safeParse / strict union, since we are
      // only asserting on the prompt we *sent*).
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                shortSummary: "x",
                detailedAnalysis: "x",
                marketContext: "x",
                scenarios: [],
                confidence: 50,
                confidenceMin: 40,
                confidenceMax: 60,
                direction: "neutral",
                riskWarnings: [],
                tradePlan: null,
                fundamentalCitations: {
                  newsTitles: [],
                  calendarEvents: [],
                },
              }),
            },
          },
        ],
      } as any;
  }) as any);
  try {
    await generateAnalysis(instrument, timeframe, mode);
  } catch {
    // Validation may still throw for missing mode-specific fields;
    // we already captured the user message we care about.
  }
  expect(captured.length).toBeGreaterThan(0);
  return captured[0]!;
}

describe("Indonesian-native style guide is injected on every analysis", () => {
  it.each(["beginner", "pro"] as const)(
    "mode=%s — user message includes GAYA BAHASA INDONESIA block with anti-emoji + anti-lo/gw rules",
    async (mode) => {
      const msg = await runAndCaptureUserMessage(mode);

      expect(msg).toContain("GAYA BAHASA INDONESIA");
      expect(msg).toMatch(/JANGAN gunakan lo\/gw/);
      expect(msg).toMatch(/JANGAN gunakan emoji/);
      // At least one canonical analogy bucket must be present so the
      // prompt actually demonstrates the style.
      expect(msg).toMatch(
        /pasar lagi kalem|antri di pintu tol|commuter line|narik napas|kandang/,
      );
      // Analogies must be tied to evidence, not free-floating.
      expect(msg).toMatch(/ANALOGI WAJIB JUSTIFIED/);
    },
  );
});

describe("confidence reasoning is grounded in the selected market", () => {
  it.each(["beginner", "pro"] as const)("mode=%s requires product-specific evidence and a concise caveat", async (mode) => {
    const system = await runAndCaptureUserMessage(mode, "system", "BRENT", "4h");
    expect(system).toMatch(/• Dasar:.*• Batasan:/s);
    expect(system).toMatch(/instrumen.*timeframe/i);
    expect(system).toMatch(/jangan mengarang.*berita masa depan|jangan mengarang.*berita/i);
    const user = await runAndCaptureUserMessage(mode, "user", "BRENT", "4h");
    expect(user).toContain("instrumen: BRENT, timeframe: 4h");
  });
});
