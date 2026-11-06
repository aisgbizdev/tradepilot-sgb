import { describe, expect, it } from "vitest";
import { evaluateOutcome, parsePlanLevel } from "../outcomes.js";

describe("parsePlanLevel", () => {
  it("parses single price", () => {
    expect(parsePlanLevel("1.0850")).toBeCloseTo(1.085);
  });

  it("treats hyphen as range separator, not a sign", () => {
    // Regression: a /-?\d+/ pattern would turn the second token into a
    // negative number and produce a midpoint near zero.
    const mid = parsePlanLevel("1.0850-1.0860");
    expect(mid).not.toBeNull();
    expect(mid!).toBeCloseTo(1.0855, 6);
  });

  it("parses 'to' separated ranges", () => {
    expect(parsePlanLevel("2300 to 2310")).toBeCloseTo(2305);
  });

  it("handles comma decimal", () => {
    expect(parsePlanLevel("1,0850")).toBeCloseTo(1.085);
  });

  it("returns null when no number present", () => {
    expect(parsePlanLevel("market")).toBeNull();
    expect(parsePlanLevel(null)).toBeNull();
  });
});

const plan = {
  entryZone: "100",
  stopLoss: "95",
  takeProfit1: "105",
  takeProfit2: "110",
  riskRewardRatio: "1:2",
  rationale: "test",
};

function bar(date: string, high: number, low: number) {
  return { date, high, low };
}

describe("evaluateOutcome", () => {
  const start = Date.UTC(2026, 0, 1);
  const validUntil = start + 24 * 60 * 60 * 1000;

  it("hits SL inside window", () => {
    const r = evaluateOutcome(
      "buy",
      plan,
      [bar("2026-01-01T01:00:00Z", 101, 94)],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(r.status).toBe("sl_hit");
  });

  it("ignores SL hit AFTER validity expiry", () => {
    // SL printed one hour after the plan expired — must NOT resolve sl_hit.
    const afterExpiry = validUntil + 60 * 60 * 1000;
    const r = evaluateOutcome(
      "buy",
      plan,
      [
        bar("2026-01-01T01:00:00Z", 101, 99),
        bar(new Date(afterExpiry).toISOString(), 101, 90),
      ],
      start,
      validUntil,
      afterExpiry + 60 * 1000,
    );
    expect(r.status).toBe("expired");
  });

  it("TP1 inside window stays pending until expiry, then resolves tp1_hit", () => {
    const beforeExpiry = start + 60 * 60 * 1000;
    const pending = evaluateOutcome(
      "buy",
      plan,
      [bar("2026-01-01T01:00:00Z", 106, 99)],
      start,
      validUntil,
      beforeExpiry + 60 * 1000,
    );
    expect(pending.status).toBe("pending");

    const resolved = evaluateOutcome(
      "buy",
      plan,
      [bar("2026-01-01T01:00:00Z", 106, 99)],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(resolved.status).toBe("tp1_hit");
  });

  it("TP2 in window wins over earlier TP1", () => {
    const r = evaluateOutcome(
      "buy",
      plan,
      [
        bar("2026-01-01T01:00:00Z", 106, 99),
        bar("2026-01-01T02:00:00Z", 111, 100),
      ],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(r.status).toBe("tp2_hit");
  });

  it("SL wins over TP on same bar (conservative)", () => {
    const r = evaluateOutcome(
      "buy",
      plan,
      [bar("2026-01-01T01:00:00Z", 111, 94)],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(r.status).toBe("sl_hit");
  });

  it("invalidates when SL is on the wrong side of entry", () => {
    const r = evaluateOutcome(
      "buy",
      { ...plan, stopLoss: "105" },
      [bar("2026-01-01T01:00:00Z", 102, 101)],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(r.status).toBe("invalidated");
  });

  it("works for sell side", () => {
    const sellPlan = {
      entryZone: "100",
      stopLoss: "105",
      takeProfit1: "95",
      takeProfit2: "90",
      riskRewardRatio: "1:2",
      rationale: "test",
    };
    const r = evaluateOutcome(
      "sell",
      sellPlan,
      [bar("2026-01-01T01:00:00Z", 101, 89)],
      start,
      validUntil,
      validUntil + 1000,
    );
    expect(r.status).toBe("tp2_hit");
  });

  it("scores only the Standard Plan when an Adaptive ladder is present", () => {
    const adaptiveOnlyData = {
      ...plan,
      adaptivePlan: {
        buy: {
          ladder: [{ level: 1, price: 90, lot: 99 }],
        },
        sell: {
          ladder: [{ level: 1, price: 110, lot: 99 }],
        },
      },
    };

    const standardResult = evaluateOutcome(
      "buy",
      plan,
      [bar("2026-01-01T01:00:00Z", 106, 99)],
      start,
      validUntil,
      validUntil + 1000,
    );
    const resultWithAdaptiveData = evaluateOutcome(
      "buy",
      adaptiveOnlyData,
      [bar("2026-01-01T01:00:00Z", 106, 99)],
      start,
      validUntil,
      validUntil + 1000,
    );

    expect(resultWithAdaptiveData).toEqual(standardResult);
    expect(resultWithAdaptiveData.status).toBe("tp1_hit");
  });
});
