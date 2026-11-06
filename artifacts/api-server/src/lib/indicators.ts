export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Signal = "Buy" | "Sell" | "Neutral";

export interface MAResult {
  period: number;
  type: "SMA" | "EMA";
  value: number;
  signal: Signal;
}

export interface OscillatorResult {
  name: string;
  value: number;
  signal: Signal;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  signal: Signal;
}

export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
  action: Signal;
}

export interface StochasticResult {
  k: number;
  d: number;
  signal: Signal;
}

export interface TechnicalIndicators {
  symbol: string;
  dataPoints: number;
  lastClose: number;
  lastDate: string;
  change1d: number;
  change1dPct: number;
  change5d: number;
  change5dPct: number;
  change20d: number;
  change20dPct: number;
  rsi14: OscillatorResult;
  macd: MACDResult;
  stochastic: StochasticResult;
  bollinger: BollingerResult;
  movingAverages: MAResult[];
  oscillatorSummary: { buy: number; sell: number; neutral: number };
  maSummary: { buy: number; sell: number; neutral: number };
  overallSummary: { buy: number; sell: number; neutral: number; signal: Signal };
}

function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prevEma = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prevEma);
  for (let i = period; i < data.length; i++) {
    prevEma = data[i] * k + prevEma * (1 - k);
    result.push(prevEma);
  }
  return result;
}

function stdDev(data: number[]): number {
  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const sq = data.map((v) => Math.pow(v - mean, 2));
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / data.length);
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rsiSignal(rsi: number): Signal {
  if (rsi < 30) return "Buy";
  if (rsi > 70) return "Sell";
  if (rsi < 45) return "Buy";
  if (rsi > 55) return "Sell";
  return "Neutral";
}

function calcMACD(closes: number[]): MACDResult {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const minLen = Math.min(ema12.length, ema26.length);
  const macdLine: number[] = [];
  for (let i = 0; i < minLen; i++) {
    macdLine.push(ema12[ema12.length - minLen + i] - ema26[ema26.length - minLen + i]);
  }
  const signalLine = ema(macdLine, 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const histogram = lastMacd - lastSignal;
  let action: Signal = "Neutral";
  if (lastMacd > lastSignal && histogram > 0) action = "Buy";
  else if (lastMacd < lastSignal && histogram < 0) action = "Sell";
  return { macd: lastMacd, signal: lastSignal, histogram, action };
}

function calcStochastic(candles: Candle[], period = 14, smoothK = 3): StochasticResult {
  if (candles.length < period) return { k: 50, d: 50, signal: "Neutral" };
  const kValues: number[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const lowestLow = Math.min(...slice.map((c) => c.low));
    const highestHigh = Math.max(...slice.map((c) => c.high));
    const range = highestHigh - lowestLow;
    kValues.push(range === 0 ? 50 : ((candles[i].close - lowestLow) / range) * 100);
  }
  const kSmoothed = sma(kValues, smoothK);
  const dSmoothed = sma(kSmoothed, smoothK);
  const k = kSmoothed[kSmoothed.length - 1];
  const d = dSmoothed[dSmoothed.length - 1];
  let signal: Signal = "Neutral";
  if (k < 20 && d < 20) signal = "Buy";
  else if (k > 80 && d > 80) signal = "Sell";
  else if (k < 40) signal = "Buy";
  else if (k > 60) signal = "Sell";
  return { k, d, signal };
}

function calcBollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const smaValues = sma(closes, period);
  const lastSma = smaValues[smaValues.length - 1];
  const lastClose = closes[closes.length - 1];
  const slice = closes.slice(closes.length - period);
  const std = stdDev(slice);
  const upper = lastSma + mult * std;
  const lower = lastSma - mult * std;
  let signal: Signal = "Neutral";
  const range = upper - lower;
  if (range > 0) {
    const pos = (lastClose - lower) / range;
    if (pos < 0.2) signal = "Buy";
    else if (pos > 0.8) signal = "Sell";
  }
  return { upper, middle: lastSma, lower, signal };
}

function calcSMA(closes: number[], period: number): MAResult | null {
  if (closes.length < period) return null;
  const values = sma(closes, period);
  const value = values[values.length - 1];
  const lastClose = closes[closes.length - 1];
  return { period, type: "SMA", value, signal: lastClose > value ? "Buy" : "Sell" };
}

function calcEMA(closes: number[], period: number): MAResult | null {
  if (closes.length < period) return null;
  const values = ema(closes, period);
  const value = values[values.length - 1];
  const lastClose = closes[closes.length - 1];
  return { period, type: "EMA", value, signal: lastClose > value ? "Buy" : "Sell" };
}

function summary(signals: Signal[]): { buy: number; sell: number; neutral: number } {
  return {
    buy: signals.filter((s) => s === "Buy").length,
    sell: signals.filter((s) => s === "Sell").length,
    neutral: signals.filter((s) => s === "Neutral").length,
  };
}

function overallSignal(buy: number, sell: number): Signal {
  if (buy > sell * 1.5) return "Buy";
  if (sell > buy * 1.5) return "Sell";
  return "Neutral";
}

// Period sets for the moving-average panel. Intraday uses a shorter horizon
// because a 200-period SMA on 4h candles spans ~33 days, which dominates the
// "Buy/Sell" tally with a long-horizon trend that has nothing to do with the
// intraday signal the user is actually looking at. Daily/weekly keep the
// classic Investing.com-style ladder so the saved-analysis view (which users
// already understand) is unchanged.
const MA_PERIODS_INTRADAY = {
  sma: [10, 20, 50, 100],
  ema: [9, 21, 50],
} as const;
const MA_PERIODS_DAILY = {
  sma: [5, 10, 20, 50, 100, 200],
  ema: [10, 20, 50],
} as const;

// Timeframes treated as "intraday" for the MA-period selection. We accept the
// raw string so this module doesn't need to depend on `historical.ts`.
const INTRADAY_TF_KEYS = new Set(["1m", "5m", "15m", "30m", "1h", "4h"]);

export function calculateIndicators(
  symbol: string,
  candles: Candle[],
  timeframe?: string,
): TechnicalIndicators {
  const sorted = [...candles].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const closes = sorted.map((c) => c.close);
  const n = closes.length;
  const lastClose = closes[n - 1];
  const lastDate = sorted[n - 1].date;

  const change1d = n > 1 ? lastClose - closes[n - 2] : 0;
  const change1dPct = n > 1 ? (change1d / closes[n - 2]) * 100 : 0;
  const change5d = n > 5 ? lastClose - closes[n - 6] : 0;
  const change5dPct = n > 5 ? (change5d / closes[n - 6]) * 100 : 0;
  const change20d = n > 20 ? lastClose - closes[n - 21] : 0;
  const change20dPct = n > 20 ? (change20d / closes[n - 21]) * 100 : 0;

  const rsiVal = calcRSI(closes);
  const rsi14: OscillatorResult = { name: "RSI(14)", value: rsiVal, signal: rsiSignal(rsiVal) };
  const macdResult = calcMACD(closes);
  const stochResult = calcStochastic(sorted);
  const bollResult = calcBollinger(closes);

  const periods =
    timeframe && INTRADAY_TF_KEYS.has(timeframe) ? MA_PERIODS_INTRADAY : MA_PERIODS_DAILY;
  const movingAverages: MAResult[] = [];
  for (const p of periods.sma) {
    const r = calcSMA(closes, p);
    if (r) movingAverages.push(r);
  }
  for (const p of periods.ema) {
    const r = calcEMA(closes, p);
    if (r) movingAverages.push(r);
  }

  const oscSignals: Signal[] = [rsi14.signal, macdResult.action, stochResult.signal, bollResult.signal];
  const maSignals: Signal[] = movingAverages.map((m) => m.signal);

  const oscSum = summary(oscSignals);
  const maSum = summary(maSignals);
  const totalBuy = oscSum.buy + maSum.buy;
  const totalSell = oscSum.sell + maSum.sell;
  const totalNeutral = oscSum.neutral + maSum.neutral;
  const totalSignal = overallSignal(totalBuy, totalSell);

  return {
    symbol,
    dataPoints: n,
    lastClose,
    lastDate,
    change1d,
    change1dPct,
    change5d,
    change5dPct,
    change20d,
    change20dPct,
    rsi14,
    macd: macdResult,
    stochastic: stochResult,
    bollinger: bollResult,
    movingAverages,
    oscillatorSummary: oscSum,
    maSummary: maSum,
    overallSummary: { buy: totalBuy, sell: totalSell, neutral: totalNeutral, signal: totalSignal },
  };
}
