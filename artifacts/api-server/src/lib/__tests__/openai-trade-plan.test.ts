// Tests for the trade-plan numeric hygiene helpers in lib/openai:
// - parseLevelPrice: extract a representative price from free-text levels
// - computeRiskReward: derive "1:X.X" from entry/SL/TP1
// - reconcileTradePlanRiskReward: rewrite each side's ratio from its own levels
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseLevelPrice,
  computeRiskReward,
  reconcileTradePlanRiskReward,
  sanitizeTradePlanLevels,
  buildFastIntradayFallback,
  validateTradePlanQuality,
  generateAnalysis,
  openai,
  type TradePlan,
} from "../openai";

describe("parseLevelPrice", () => {
  it("parses a single price", () => {
    expect(parseLevelPrice("1.0850")).toBeCloseTo(1.085, 6);
  });

  it("averages a range to its midpoint", () => {
    expect(parseLevelPrice("1.0850 - 1.0865")).toBeCloseTo(1.08575, 6);
    expect(parseLevelPrice("1.0850 – 1.0865")).toBeCloseTo(1.08575, 6);
  });

  it("ignores thousands separators", () => {
    expect(parseLevelPrice("4,650.50")).toBeCloseTo(4650.5, 6);
  });

  it("pulls the number out of descriptive text", () => {
    expect(parseLevelPrice("di atas 1.0880 setelah breakout")).toBeCloseTo(
      1.088,
      6,
    );
  });

  it("ignores timeframe tokens so their digits aren't read as prices", () => {
    expect(parseLevelPrice("di atas 4680 setelah breakout H1")).toBeCloseTo(
      4680,
      6,
    );
    expect(parseLevelPrice("entry 4650 - 4665 di 4H")).toBeCloseTo(4657.5, 6);
    expect(parseLevelPrice("tunggu konfirmasi candle 30m di 2305")).toBeCloseTo(
      2305,
      6,
    );
  });

  it("returns null for purely descriptive levels", () => {
    expect(parseLevelPrice("menunggu konfirmasi di area support")).toBeNull();
    expect(parseLevelPrice("")).toBeNull();
    expect(parseLevelPrice("n/a")).toBeNull();
  });
});

describe("computeRiskReward", () => {
  it("computes a 1:2 setup", () => {
    // entry 100, SL 95 (risk 5), TP1 110 (reward 10) → 1:2
    expect(computeRiskReward("100", "95", "110")).toBe("1:2.0");
  });

  it("computes a fractional ratio from zones", () => {
    // entry mid 2305, SL 2290 (risk 15), TP1 2330 (reward 25) → 1.666...
    expect(computeRiskReward("2300-2310", "2290", "2330")).toBe("1:1.7");
  });

  it("works for a short setup (entry above SL/TP order reversed)", () => {
    // entry 100, SL 105 (risk 5), TP1 90 (reward 10) → 1:2
    expect(computeRiskReward("100", "105", "90")).toBe("1:2.0");
  });

  it("returns null when a level is non-numeric", () => {
    expect(computeRiskReward("menunggu konfirmasi", "95", "110")).toBeNull();
  });

  it("returns null when the risk leg is zero", () => {
    expect(computeRiskReward("100", "100", "110")).toBeNull();
  });

  it("returns null when levels contradict the side direction", () => {
    // buy with SL above entry / TP below entry is internally inconsistent
    expect(computeRiskReward("100", "110", "90", "buy")).toBeNull();
    // sell with SL below entry / TP above entry is inconsistent too
    expect(computeRiskReward("100", "90", "110", "sell")).toBeNull();
  });

  it("accepts levels that straddle entry in the correct direction", () => {
    expect(computeRiskReward("100", "95", "110", "buy")).toBe("1:2.0");
    expect(computeRiskReward("100", "105", "90", "sell")).toBe("1:2.0");
  });
});

describe("reconcileTradePlanRiskReward", () => {
  it("overrides a drifted ratio with the value implied by the levels", () => {
    const plan: TradePlan = {
      preferredSide: "buy",
      buy: {
        entryZone: "100",
        stopLoss: "95",
        takeProfit1: "110",
        takeProfit2: "120",
        riskRewardRatio: "1:5", // wrong on purpose
        rationale: "x",
      },
      sell: {
        entryZone: "100",
        stopLoss: "105",
        takeProfit1: "90",
        takeProfit2: "80",
        riskRewardRatio: "1:9", // wrong on purpose
        rationale: "y",
      },
    };

    const fixed = reconcileTradePlanRiskReward(plan);
    expect(fixed.buy.riskRewardRatio).toBe("1:2.0");
    expect(fixed.sell.riskRewardRatio).toBe("1:2.0");
    // Other fields untouched.
    expect(fixed.preferredSide).toBe("buy");
    expect(fixed.buy.rationale).toBe("x");
  });

  it("uses explicit pending text for descriptive (no-anchor) levels", () => {
    const plan: TradePlan = {
      preferredSide: "wait",
      buy: {
        entryZone: "di sekitar support terdekat",
        stopLoss: "menunggu konfirmasi",
        takeProfit1: "resistance terdekat",
        takeProfit2: "resistance berikutnya",
        riskRewardRatio: "1:2",
        rationale: "x",
      },
      sell: {
        entryZone: "di sekitar resistance terdekat",
        stopLoss: "menunggu konfirmasi",
        takeProfit1: "support terdekat",
        takeProfit2: "support berikutnya",
        riskRewardRatio: "1:2",
        rationale: "y",
      },
    };

    const fixed = reconcileTradePlanRiskReward(plan);
    expect(fixed.buy.riskRewardRatio).toMatch(/menunggu quote/i);
    expect(fixed.sell.riskRewardRatio).toMatch(/menunggu quote/i);
  });
});

describe("sanitizeTradePlanLevels", () => {
  it("leaves a correctly-ordered buy/sell plan untouched", () => {
    const plan: TradePlan = {
      preferredSide: "buy",
      buy: {
        entryZone: "100",
        stopLoss: "95",
        takeProfit1: "110",
        takeProfit2: "120",
        riskRewardRatio: "1:2",
        rationale: "x",
      },
      sell: {
        entryZone: "100",
        stopLoss: "105",
        takeProfit1: "90",
        takeProfit2: "80",
        riskRewardRatio: "1:2",
        rationale: "y",
      },
    };
    const sanitized = sanitizeTradePlanLevels(plan);
    expect(sanitized).toEqual(plan);
  });

  it("replaces a buy side whose SL/TP are structured like a sell (SL above entry, TP below)", () => {
    // Mirrors the real bug report: "buy" scenario with entry ~4397,
    // stopLoss 4401 (above entry), takeProfit1/2 4382/4375 (below entry) —
    // that's a short's price structure mislabeled as a buy.
    const plan: TradePlan = {
      preferredSide: "buy",
      buy: {
        entryZone: "4397.16",
        stopLoss: "4401.00",
        takeProfit1: "4382.21",
        takeProfit2: "4375.00",
        riskRewardRatio: "n/a",
        rationale: "Konfluensi resistance di 4397.16",
      },
      sell: {
        entryZone: "4382.21",
        stopLoss: "4390.00",
        takeProfit1: "4375.00",
        takeProfit2: "4365.00",
        riskRewardRatio: "1:0.9",
        rationale: "Konfluensi support kuat",
      },
    };
    const sanitized = sanitizeTradePlanLevels(plan);
    expect(sanitized.buy.entryZone).toMatch(/menunggu quote/i);
    expect(sanitized.buy.stopLoss).toMatch(/menunggu quote/i);
    expect(sanitized.buy.takeProfit1).toMatch(/menunggu quote/i);
    expect(sanitized.buy.takeProfit2).toMatch(/menunggu quote/i);
    expect(sanitized.buy.riskRewardRatio).not.toMatch(/n\/a/i);
    expect(sanitized.buy.rationale).toMatch(/belum lolos validasi arah/i);
    // The sell side was internally consistent and must be left alone.
    expect(sanitized.sell).toEqual(plan.sell);
  });

  it("replaces a sell side whose SL/TP are structured like a buy", () => {
    const plan: TradePlan = {
      preferredSide: "sell",
      buy: {
        entryZone: "100",
        stopLoss: "95",
        takeProfit1: "110",
        takeProfit2: "120",
        riskRewardRatio: "1:2",
        rationale: "x",
      },
      sell: {
        entryZone: "100",
        stopLoss: "95", // below entry — should be above for a sell
        takeProfit1: "110", // above entry — should be below for a sell
        takeProfit2: "120",
        riskRewardRatio: "1:2",
        rationale: "y",
      },
    };
    const sanitized = sanitizeTradePlanLevels(plan);
    expect(sanitized.sell.entryZone).toMatch(/menunggu quote/i);
    expect(sanitized.sell.stopLoss).toMatch(/menunggu quote/i);
    expect(sanitized.buy).toEqual(plan.buy);
  });

  it("flags a side whose takeProfit2 is not further than takeProfit1 in the trade direction", () => {
    const plan: TradePlan = {
      preferredSide: "buy",
      buy: {
        entryZone: "100",
        stopLoss: "95",
        takeProfit1: "110",
        takeProfit2: "105", // closer than TP1, not a valid "further target"
        riskRewardRatio: "1:2",
        rationale: "x",
      },
      sell: {
        entryZone: "100",
        stopLoss: "105",
        takeProfit1: "90",
        takeProfit2: "80",
        riskRewardRatio: "1:2",
        rationale: "y",
      },
    };
    const sanitized = sanitizeTradePlanLevels(plan);
    expect(sanitized.buy.entryZone).toMatch(/menunggu quote/i);
  });

  it("keeps descriptive (no-anchor / wait) levels but replaces bare n/a", () => {
    const plan: TradePlan = {
      preferredSide: "wait",
      buy: {
        entryZone: "tunggu pullback terkonfirmasi",
        stopLoss: "n/a",
        takeProfit1: "n/a",
        takeProfit2: "n/a",
        riskRewardRatio: "n/a",
        rationale: "Timeframe sangat cepat, noise tinggi.",
      },
      sell: {
        entryZone: "tunggu rejection terkonfirmasi",
        stopLoss: "n/a",
        takeProfit1: "n/a",
        takeProfit2: "n/a",
        riskRewardRatio: "n/a",
        rationale: "Timeframe sangat cepat, noise tinggi.",
      },
    };
    const sanitized = sanitizeTradePlanLevels(plan);
    expect(sanitized.buy.entryZone).toBe(plan.buy.entryZone);
    expect(sanitized.sell.entryZone).toBe(plan.sell.entryZone);
    for (const side of [sanitized.buy, sanitized.sell]) {
      expect(Object.values(side).join(" ")).not.toMatch(/n\/a/i);
      expect(side.stopLoss).toMatch(/menunggu quote/i);
    }
  });
});

describe("validateTradePlanQuality", () => {
  const validPlan: TradePlan = {
    preferredSide: "buy",
    buy: {
      entryZone: "99-100",
      stopLoss: "95",
      takeProfit1: "110",
      takeProfit2: "120",
      riskRewardRatio: "1:2",
      rationale: "Support 99-100 dan swing low 95.",
    },
    sell: {
      entryZone: "100",
      stopLoss: "105",
      takeProfit1: "90",
      takeProfit2: "80",
      riskRewardRatio: "1:2",
      rationale: "Rejection resistance 100 dengan swing high 105.",
    },
  };

  it("requires concrete, directional levels for both sides when quote is available", () => {
    expect(validateTradePlanQuality(validPlan, 100, "1D", "XAU/USD")).toEqual({
      ok: true,
    });
    const malformed = {
      ...validPlan,
      buy: { ...validPlan.buy, takeProfit2: "resistance berikutnya" },
    };
    expect(validateTradePlanQuality(malformed, 100, "1D", "XAU/USD")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/TP2 numerik/i),
    });
  });

  it("rejects invented numeric levels without an anchor but accepts pending scenarios", () => {
    expect(validateTradePlanQuality(validPlan, null, "1D", "XAU/USD")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/tanpa quote/i),
    });
    const pending: TradePlan = {
      preferredSide: "wait",
      buy: {
        entryZone: "Entry pending sampai quote dan support terkonfirmasi",
        stopLoss: "Menunggu swing-low terukur",
        takeProfit1: "Menunggu resistance terdekat",
        takeProfit2: "Menunggu resistance lanjutan",
        riskRewardRatio: "Belum dihitung sebelum ada quote",
        rationale: "Tidak ada anchor harga andal.",
      },
      sell: {
        entryZone: "Entry pending sampai quote dan resistance terkonfirmasi",
        stopLoss: "Menunggu swing-high terukur",
        takeProfit1: "Menunggu support terdekat",
        takeProfit2: "Menunggu support lanjutan",
        riskRewardRatio: "Belum dihitung sebelum ada quote",
        rationale: "Tidak ada anchor harga andal.",
      },
    };
    expect(validateTradePlanQuality(pending, null, "1D", "XAU/USD")).toEqual({
      ok: true,
    });
  });

  it("rejects wildly off-quote levels but allows broad, plausible weekly setups", () => {
    const offQuotePlan: TradePlan = {
      preferredSide: "buy",
      buy: {
        entryZone: "990-1000",
        stopLoss: "950",
        takeProfit1: "1100",
        takeProfit2: "1200",
        riskRewardRatio: "1:2",
        rationale: "Structure setup.",
      },
      sell: {
        entryZone: "1000",
        stopLoss: "1050",
        takeProfit1: "900",
        takeProfit2: "800",
        riskRewardRatio: "1:2",
        rationale: "Structure setup.",
      },
    };
    expect(validateTradePlanQuality(offQuotePlan, 100, "1W", "XAU/USD"))
      .toMatchObject({
        ok: false,
        reason: expect.stringMatching(/terlalu jauh dari quote/i),
      });

    const broadWeeklyPlan: TradePlan = {
      preferredSide: "wait",
      buy: {
        entryZone: "80",
        stopLoss: "60",
        takeProfit1: "130",
        takeProfit2: "150",
        riskRewardRatio: "1:2.5",
        rationale: "Weekly support zone.",
      },
      sell: {
        entryZone: "120",
        stopLoss: "150",
        takeProfit1: "80",
        takeProfit2: "60",
        riskRewardRatio: "1:1.3",
        rationale: "Weekly resistance zone.",
      },
    };
    expect(validateTradePlanQuality(broadWeeklyPlan, 100, "1W", "XAU/USD"))
      .toEqual({ ok: true });
  });
});

describe("generateAnalysis — trade-plan corrective retry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function response(takeProfit2: string) {
    return {
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({
            marketCondition: "ranging",
            riskLevel: "medium",
            confidenceMin: 45,
            confidenceMax: 60,
            tradingBias: "neutral",
            opportunity: "Pada timeframe, dua reaksi level masih mungkin.",
            risk: "Kedua skenario dapat gagal bila struktur berubah.",
            mainScenario: "Pada timeframe, harga menunggu reaksi level.",
            alternativeScenario: "Jika support patah, skenario turun aktif.",
            whyReason: "Struktur belum memberi konfirmasi satu arah.",
            failureConditions: "Close di bawah support; Break resistance",
            tradePlan: {
              preferredSide: "wait",
              buy: {
                entryZone: "999-1000",
                stopLoss: "950",
                takeProfit1: "1030",
                takeProfit2,
                riskRewardRatio: "1:2",
                rationale: "Support 999-1000 dan swing low 950.",
              },
              sell: {
                entryZone: "1000",
                stopLoss: "1050",
                takeProfit1: "970",
                takeProfit2: "930",
                riskRewardRatio: "1:2",
                rationale: "Resistance 1000 dan swing high 1050.",
              },
            },
            fundamentalCitations: { newsTitles: [], calendarEvents: [] },
          }),
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    };
  }

  function pendingResponse() {
    const result = response("120");
    const output = JSON.parse(result.choices[0]!.message.content!);
    output.tradePlan = {
      preferredSide: "wait",
      buy: {
        entryZone: "Entry pending sampai quote dan support terkonfirmasi",
        stopLoss: "Menunggu swing-low terukur",
        takeProfit1: "Menunggu resistance terdekat",
        takeProfit2: "Menunggu resistance lanjutan",
        riskRewardRatio: "Belum dihitung sebelum ada quote",
        rationale: "Tidak ada quote timeframe utama yang andal.",
      },
      sell: {
        entryZone: "Entry pending sampai quote dan resistance terkonfirmasi",
        stopLoss: "Menunggu swing-high terukur",
        takeProfit1: "Menunggu support terdekat",
        takeProfit2: "Menunggu support lanjutan",
        riskRewardRatio: "Belum dihitung sebelum ada quote",
        rationale: "Tidak ada quote timeframe utama yang andal.",
      },
    };
    result.choices[0]!.message.content = JSON.stringify(output);
    return result;
  }

  it.each(["1m", "5m", "1h"])(
    "retries a malformed TP2 on %s and preserves the valid Sell scenario",
    async (timeframe) => {
      const createSpy = vi.spyOn(openai.chat.completions, "create")
        .mockResolvedValueOnce(response("resistance lanjutan") as never)
        .mockResolvedValueOnce(response("1060") as never);

      const result = await generateAnalysis(
        "XAU/USD",
        timeframe,
        "beginner",
        undefined,
        undefined,
        undefined,
        1000,
      );
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(result.output.tradePlan.buy.takeProfit2).toBe("1060");
      expect(result.output.tradePlan.sell.entryZone).toBe("1000");
      expect(createSpy.mock.calls[0]?.[0].messages[0]?.content).toMatch(
        /Bandingkan keselarasan atau konflik timeframe/i,
      );
      expect(createSpy.mock.calls[0]?.[0].messages[0]?.content).toMatch(
        /satu sisi lebih diutamakan|preferredSide lebih didukung/i,
      );
      expect(createSpy.mock.calls[1]?.[0].messages[1]?.content).toMatch(
        /TP2 numerik yang valid/i,
      );
    },
  );

  it("throws instead of returning a generic paid fallback after repeated bad levels", async () => {
    vi.spyOn(openai.chat.completions, "create")
      .mockResolvedValue(response("resistance lanjutan") as never);
    await expect(
      generateAnalysis("XAU/USD", "1m", "beginner", undefined, undefined, undefined, 1000),
    ).rejects.toThrow(/trade-plan quality failed after retry/i);
  });

  it("does not accept a secondary-timeframe quote as the selected timeframe anchor", async () => {
    const createSpy = vi.spyOn(openai.chat.completions, "create")
      .mockResolvedValueOnce(response("120") as never)
      .mockResolvedValueOnce(pendingResponse() as never);
    const comparisonContext = [
      "TIMEFRAME PEMBANDING (4h)",
      "=== DATA TEKNIKAL (XAU/USD, timeframe 4h) ===",
      "Harga terakhir: 100",
    ].join("\n");

    const result = await generateAnalysis(
      "XAU/USD",
      "1D",
      "beginner",
      undefined,
      comparisonContext,
      undefined,
      null,
      null,
    );

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[1]?.[0].messages[1]?.content).toMatch(
      /tanpa quote \/ anchor harga yang andal/i,
    );
    for (const side of [
      result.output.tradePlan.buy,
      result.output.tradePlan.sell,
    ]) {
      expect(Object.values(side).join(" ")).not.toMatch(/n\/a/i);
      expect(side.entryZone).toMatch(/pending/i);
    }
  });

  it("propagates an AI failure for 1m rather than treating generic analysis as paid success", async () => {
    vi.spyOn(openai.chat.completions, "create")
      .mockRejectedValue(new Error("upstream unavailable"));
    await expect(
      generateAnalysis("XAU/USD", "1m", "beginner"),
    ).rejects.toThrow(/upstream unavailable/i);
  });

  it("aborts and rejects a normal-timeframe request at its deadline without SDK retries", async () => {
    vi.useFakeTimers();
    const createSpy = vi.spyOn(openai.chat.completions, "create")
      .mockImplementation((() => new Promise(() => undefined)) as never);
    const analysis = generateAnalysis("XAU/USD", "1h", "beginner");
    const rejection = expect(analysis).rejects.toThrow(
      /OpenAI timeout after 25000ms/i,
    );
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;

    const requestOptions = createSpy.mock.calls[0]?.[1];
    expect(requestOptions?.signal?.aborted).toBe(true);
    expect(requestOptions?.maxRetries).toBe(0);
  });
});

describe("buildFastIntradayFallback", () => {
  it.each(["1m", "5m"])(
    "keeps %s conservative but replaces bare n/a values with an observation plan",
    (timeframe) => {
      const fallback = buildFastIntradayFallback("beginner", timeframe);

      expect(fallback.tradingBias).toBe("neutral");
      expect(fallback.riskLevel).toBe("high");
      expect(fallback.tradePlan.preferredSide).toBe("wait");
      for (const side of [fallback.tradePlan.buy, fallback.tradePlan.sell]) {
        expect(Object.values(side).join(" ").toLowerCase()).not.toContain("n/a");
        expect(side.entryZone).toContain(`candle ${timeframe}`);
        expect(side.rationale.toLowerCase()).toContain("analisis ulang");
      }
    },
  );

  it("does not alter the normal-timeframe fallback contract because it is only used for 1m/5m", () => {
    const fallback = buildFastIntradayFallback("pro", "5m");
    expect(fallback.tradePlan.buy.entryZone).toMatch(/resistance mikro/i);
    expect(fallback.tradePlan.sell.entryZone).toMatch(/support mikro/i);
  });
});
