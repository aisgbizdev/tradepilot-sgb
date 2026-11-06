import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAnalysis, openai, type TradePlan } from "../openai";
import { evaluateMarketPlan } from "../market-evaluation";
import { SUPPORTED_INDICATOR_TIMEFRAMES } from "../historical";
import { marketSnapshots } from "./fixtures/market-snapshots";

const order = SUPPORTED_INDICATOR_TIMEFRAMES;
const adjacent = (instrument: string, timeframe: string) => {
  const index = order.indexOf(timeframe as (typeof order)[number]);
  return marketSnapshots.find((s) => s.instrument === instrument &&
    s.timeframe === order[Math.min(index + 1, order.length - 1)]);
};

// Offline control plan: it tests the evaluator and fixture coverage, not AI
// quality. The opt-in live run below is the only test of actual model behavior.
function controlPlan(quote: number, span: number): TradePlan {
  const p = (n: number) => String(Number(n.toFixed(4)));
  const step = Math.max(span / 20, quote * 0.0001);
  return {
    preferredSide: "wait",
    buy: {
      entryZone: p(quote + step), stopLoss: p(quote - step),
      takeProfit1: p(quote + step * 2), takeProfit2: p(quote + step * 3),
      riskRewardRatio: "1:0.5", rationale: "Break resistance setelah candle konfirmasi.",
    },
    sell: {
      entryZone: p(quote - step), stopLoss: p(quote + step),
      takeProfit1: p(quote - step * 2), takeProfit2: p(quote - step * 3),
      riskRewardRatio: "1:0.5", rationale: "Break support setelah candle konfirmasi.",
    },
  };
}

describe("dated market snapshot evaluation (offline, zero AI calls)", () => {
  it("covers every supported timeframe for each instrument with an attributed, dated quote", () => {
    expect(marketSnapshots).toHaveLength(4 * order.length);
    for (const instrument of ["XAU/USD", "BRENT", "HSI", "NIKKEI"]) {
      expect(marketSnapshots.filter((s) => s.instrument === instrument).map((s) => s.timeframe))
        .toEqual(order);
    }
    for (const sample of marketSnapshots) {
      expect(Date.parse(sample.observedAt)).not.toBeNaN();
      expect(sample.source.length).toBeGreaterThan(5);
      expect(sample.low).toBeLessThanOrEqual(sample.quote);
      expect(sample.high).toBeGreaterThanOrEqual(sample.quote);
      const report = evaluateMarketPlan(sample, controlPlan(sample.quote, sample.high - sample.low),
        adjacent(sample.instrument, sample.timeframe));
      expect(report.completeBothSides).toBe(true);
      expect(report.productionValidation.ok).toBe(true);
      expect(report.maxDistancePct).not.toBeNull();
      expect(report.timeframeDifference).not.toBe("no adjacent snapshot");
    }
  });

  it("flags quote distance, missing opposite, unsupported reasons and timeframe conflict even if level order passes", () => {
    const sample = marketSnapshots.find((s) => s.instrument === "BRENT" && s.timeframe === "30m")!;
    const comparison = adjacent(sample.instrument, sample.timeframe)!;
    const plan = controlPlan(sample.quote, sample.high - sample.low);
    plan.preferredSide = "buy";
    plan.buy = { ...plan.buy, entryZone: "110", stopLoss: "109", takeProfit1: "111", takeProfit2: "112", rationale: "Buy sekarang." };
    plan.sell = { ...plan.sell, entryZone: "menunggu", rationale: "Sell sekarang." };
    const result = evaluateMarketPlan(sample, plan, comparison);
    expect(result.completeBothSides).toBe(false);
    expect(result.anomalies.join(" ")).toMatch(/entry .*from quote/);
    expect(result.anomalies.join(" ")).toMatch(/rationale lacks technical evidence/);
    expect(result.anomalies.join(" ")).toMatch(/opposing adjacent timeframe/);
    expect(result.preferredReason).toBe("Buy sekarang.");
    expect(result.levels.sell.entry).toBeNull();
  });
});

const runLive = process.env["MARKET_EVAL_LIVE"] === "1";
describe.skipIf(!runLive)("live AI evaluation against frozen real-market snapshots (internal budget)", () => {
  afterEach(() => vi.restoreAllMocks());
  it("reports every attempt, rejection, correction and per-timeframe anomaly without user credits", async () => {
    const instrument = process.env["MARKET_EVAL_INSTRUMENT"];
    const timeframe = process.env["MARKET_EVAL_TIMEFRAME"];
    if (!instrument || !timeframe) throw new Error("Set MARKET_EVAL_INSTRUMENT and MARKET_EVAL_TIMEFRAME");
    const sample = marketSnapshots.find((s) => s.instrument === instrument && s.timeframe === timeframe);
    if (!sample) throw new Error("No frozen snapshot for selected instrument/timeframe");
    // Upper bound: one analysis, at most three model calls, 1800 generated
    // tokens per call. Prompt is a bounded summary, no news/user input.
    // Reserve 20k tokens before calling (internal evaluation only).
    const budget = Number(process.env["MARKET_EVAL_TOKEN_BUDGET"]);
    if (!Number.isFinite(budget) || budget < 20_000) {
      throw new Error("Explicit MARKET_EVAL_TOKEN_BUDGET >= 20000 required for a live run");
    }
    const original = openai.chat.completions.create.bind(openai.chat.completions);
    let attempts = 0;
    let reservedTokens = 0;
    const correctionReasons: string[] = [];
    vi.spyOn(openai.chat.completions, "create").mockImplementation((async (body: Parameters<typeof original>[0], options: Parameters<typeof original>[1]) => {
      if (++attempts > 3) throw new Error("Market evaluation call limit exceeded");
      const message = String(body.messages[1]?.content ?? "");
      if (message.includes("[KOREKSI WAJIB — LEVEL TRADE PLAN]")) correctionReasons.push("trade plan");
      else if (message.includes("[KOREKSI WAJIB — GROUNDING]")) correctionReasons.push("citations");
      else if (message.includes("[KOREKSI WAJIB]")) correctionReasons.push("schema");
      const maxOutput = Math.min(body.max_tokens ?? 1800, 1800);
      // One token cannot encode less than one UTF-16 code unit of prompt
      // text; character count + maximum output is a conservative reservation.
      const promptCeiling = body.messages.reduce((total, item) =>
        total + String(item.content ?? "").length, 0) + 500;
      if (reservedTokens + promptCeiling + maxOutput > budget) {
        throw new Error("Market evaluation token budget exceeded before AI request");
      }
      reservedTokens += promptCeiling + maxOutput;
      const response = await original({ ...body, max_tokens: maxOutput }, options);
      if ("usage" in response && response.usage) {
        reservedTokens -= promptCeiling + maxOutput - response.usage.total_tokens;
      }
      return response;
    }) as typeof openai.chat.completions.create);
    const technical = [
      `=== DATA TEKNIKAL (${sample.instrument}, timeframe ${sample.timeframe}) ===`,
      `Harga terakhir: ${sample.quote} (${sample.observedAt}; ${sample.source})`,
      `Range ${sample.bars} bar terakhir: low ${sample.low}, high ${sample.high}.`,
      `Perubahan pada ${sample.bars} bar: ${sample.changePct}%.`,
      `TIMEFRAME PEMBANDING (bukan anchor): ${(() => {
        const other = adjacent(sample.instrument, sample.timeframe);
        return other ? `${other.timeframe}: perubahan ${other.changePct}%, range ${other.low}-${other.high}` : "tidak tersedia";
      })()}`,
      "Tidak ada RSI/MACD pada fixture ini; jangan mengarang nilai indikator.",
    ].join("\n");
    let report: ReturnType<typeof evaluateMarketPlan> | null = null;
    let error: string | null = null;
    let usedTokens: number | null = null;
    try {
      const result = await generateAnalysis(instrument, timeframe, "beginner",
        undefined, technical, null, null, sample.quote);
      usedTokens = result.usage.totalTokens;
      report = evaluateMarketPlan(sample, result.output.tradePlan, adjacent(instrument, timeframe));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const summary = {
      snapshot: { instrument, timeframe, at: sample.observedAt, source: sample.source },
      attempts, corrections: correctionReasons.length, correctionReasons,
      rejected: Number(Boolean(error)), rejectionRate: Number(Boolean(error)),
      correctionRate: Number(attempts > 1), usedTokens,
      budgetTokens: budget, error, report,
      disclaimer: "Evaluasi snapshot historis, bukan prediksi atau klaim profit; tidak menggunakan kredit pengguna.",
    };
    process.stdout.write(`MARKET_EVAL_REPORT ${JSON.stringify(summary)}\n`);
    expect(attempts).toBeLessThanOrEqual(3);
    expect(error).toBeNull();
    expect(usedTokens).not.toBeNull();
    expect(usedTokens!).toBeLessThanOrEqual(budget);
    // Live anomalies are reported for review, not silently normalized into
    // a passing claim about the market or treated as a deterministic CI gate.
    expect(report).not.toBeNull();
  }, 90_000);
});