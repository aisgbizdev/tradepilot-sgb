// Tier 2 push (task #141 A): detect abnormal short-term price moves on
// any watchlist instrument and fire a single push per (user, instrument,
// 3h-window). Every send funnels through the shared anti-annoyance
// guards in `lib/notification-guards.ts` (quiet hours, freq cap, dedupe).

import { db } from "./db";
import { users, watchlistItems } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { getLiveQuotes } from "./live-prices";
import { getCandles } from "./historical";
import {
  alreadyDelivered,
  respectFrequencyCap,
  withinQuietHours,
} from "./notification-guards";

const CATEGORY = "price_anomaly";
const PER_DAY_CAP = 2;
const PER_INSTRUMENT_WINDOW_MS = 3 * 60 * 60 * 1000; // 3h bucket
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Asset-class thresholds for the absolute 5-minute change (% units).
// FX majors move in fractions of a percent intraday — a 0.5% tick is
// already very large. Indices / commodities are 2x noisier so we
// require ~1% before we call it an anomaly.
const FX_MAJOR_5M_THRESHOLD_PCT = 0.5;
const INDEX_COMMODITY_5M_THRESHOLD_PCT = 1.0;
const FX_MAJORS = new Set([
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/IDR",
  "AUD/USD",
  "USD/CHF",
  "DXY",
]);
// "Index/commodity" for our purposes — everything we cover that isn't
// a pure FX pair. Unknown symbols default to the FX threshold so we
// stay conservative (less likely to spam).
const INDEX_COMMODITY = new Set(["XAU/USD", "BRENT", "HK50", "NIKKEI", "HSI"]);

export function fiveMinuteThresholdFor(instrument: string): number {
  if (FX_MAJORS.has(instrument)) return FX_MAJOR_5M_THRESHOLD_PCT;
  if (INDEX_COMMODITY.has(instrument)) return INDEX_COMMODITY_5M_THRESHOLD_PCT;
  return FX_MAJOR_5M_THRESHOLD_PCT;
}

// ---------- In-memory price snapshot ring per instrument ----------
// The job tick is 5 min so we only need a handful of past snapshots to
// compute 5m and 30m changes. Keep the last 12 (1h) per instrument.
const MAX_SNAPSHOTS = 12;
type Snapshot = { price: number; ts: number };
const snapshots = new Map<string, Snapshot[]>();

export function recordSnapshot(instrument: string, price: number, ts: number): void {
  const arr = snapshots.get(instrument) ?? [];
  arr.push({ price, ts });
  while (arr.length > MAX_SNAPSHOTS) arr.shift();
  snapshots.set(instrument, arr);
}

/** Test/debug hook — wipe the in-process snapshot ring. */
export function _clearSnapshots(): void {
  snapshots.clear();
}

/**
 * Return abs(%change) between `price` now and the snapshot closest to
 * `now - windowMs`, tolerating ±20% of the window. Returns null when
 * we don't yet have a baseline in range (cold start, gap, etc.).
 */
export function pctChangeAcross(
  instrument: string,
  nowPrice: number,
  now: number,
  windowMs: number,
): number | null {
  const arr = snapshots.get(instrument);
  if (!arr || arr.length === 0) return null;
  const target = now - windowMs;
  const tolerance = windowMs * 0.2;
  let best: Snapshot | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of arr) {
    const diff = Math.abs(s.ts - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  if (!best || bestDiff > tolerance) return null;
  if (!Number.isFinite(best.price) || best.price === 0) return null;
  if (!Number.isFinite(nowPrice)) return null;
  return Math.abs((nowPrice - best.price) / best.price) * 100;
}

// ---------- Rolling 30-day stddev cache ----------
// Refresh once per UTC day per instrument. Stddev is computed over
// daily log-returns to keep large-scale moves comparable across
// asset classes. Multiplied by sqrt(0.0625) ≈ 0.25 to project from a
// daily move down to a 30-min slice (very rough, but good enough as a
// "abnormal vs your own history" threshold).
const STDDEV_REFRESH_MS = 24 * 60 * 60 * 1000;
type StddevEntry = { dailyStddevPct: number; computedAt: number };
const stddevCache = new Map<string, StddevEntry>();

export function _clearStddevCache(): void {
  stddevCache.clear();
}

export function computeStddevPct(closes: number[]): number | null {
  if (closes.length < 5) return null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push(Math.log(cur / prev));
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (returns.length - 1);
  if (!Number.isFinite(variance) || variance <= 0) return null;
  // log-return stddev → approximate percentage stddev (small-x).
  return Math.sqrt(variance) * 100;
}

async function getDailyStddevPct(instrument: string): Promise<number | null> {
  const cached = stddevCache.get(instrument);
  if (cached && Date.now() - cached.computedAt < STDDEV_REFRESH_MS) {
    return cached.dailyStddevPct;
  }
  try {
    const candles = await getCandles(instrument, "1D");
    if (!candles || candles.length === 0) return null;
    const closes = candles.slice(-30).map((c) => c.close);
    const stddev = computeStddevPct(closes);
    if (stddev === null) return null;
    stddevCache.set(instrument, { dailyStddevPct: stddev, computedAt: Date.now() });
    return stddev;
  } catch (err) {
    logger.warn({ err, instrument }, "stddev fetch failed");
    return null;
  }
}

// Project a daily stddev into a 30-minute window. Markets trade roughly
// 24h * 60min = 1440 min/day, so a 30m slice is √(30/1440) ≈ 0.144 of
// the daily move under the standard Brownian-motion assumption.
const THIRTY_MIN_SCALE = Math.sqrt(30 / 1440);

export function thirtyMinAnomalyThresholdPct(dailyStddevPct: number): number {
  return dailyStddevPct * THIRTY_MIN_SCALE * 3;
}

interface WatchlistUser {
  id: number;
  pushPriceAnomaly: boolean;
  dailySummaryTimezone: string | null;
  instruments: string[];
}

async function loadWatchlistUsers(): Promise<WatchlistUser[]> {
  const items = await db
    .select({ userId: watchlistItems.userId, instrument: watchlistItems.instrument })
    .from(watchlistItems);
  if (items.length === 0) return [];
  const byUser = new Map<number, string[]>();
  for (const it of items) {
    const arr = byUser.get(it.userId) ?? [];
    arr.push(it.instrument);
    byUser.set(it.userId, arr);
  }
  const userIds = Array.from(byUser.keys());
  const prefs = await db
    .select({
      id: users.id,
      pushPriceAnomaly: users.pushPriceAnomaly,
      dailySummaryTimezone: users.dailySummaryTimezone,
    })
    .from(users)
    .where(inArray(users.id, userIds));
  return prefs.map((u) => ({
    id: u.id,
    pushPriceAnomaly: u.pushPriceAnomaly,
    dailySummaryTimezone: u.dailySummaryTimezone ?? null,
    instruments: byUser.get(u.id) ?? [],
  }));
}

interface AnomalySignal {
  instrument: string;
  pctMove: number;
  windowMinutes: number;
  reason: "5m_threshold" | "30m_stddev";
}

export interface DetectAnomalyInputs {
  instrument: string;
  nowPrice: number;
  now: number;
  dailyStddevPct: number | null;
}

/** Pure helper — exported for tests. Returns the strongest signal or null. */
export function detectAnomaly(input: DetectAnomalyInputs): AnomalySignal | null {
  const { instrument, nowPrice, now, dailyStddevPct } = input;
  const fiveMin = pctChangeAcross(instrument, nowPrice, now, 5 * 60 * 1000);
  const thirtyMin = pctChangeAcross(instrument, nowPrice, now, 30 * 60 * 1000);
  const fiveThr = fiveMinuteThresholdFor(instrument);
  if (fiveMin !== null && fiveMin >= fiveThr) {
    return { instrument, pctMove: fiveMin, windowMinutes: 5, reason: "5m_threshold" };
  }
  if (thirtyMin !== null && dailyStddevPct !== null) {
    const thr = thirtyMinAnomalyThresholdPct(dailyStddevPct);
    if (thr > 0 && thirtyMin >= thr) {
      return { instrument, pctMove: thirtyMin, windowMinutes: 30, reason: "30m_stddev" };
    }
  }
  return null;
}

interface DispatchStats {
  candidates: number;
  sent: number;
  suppressedQuiet: number;
  suppressedCap: number;
  suppressedDedupe: number;
  suppressedOptOut: number;
}

function emptyStats(): DispatchStats {
  return {
    candidates: 0,
    sent: 0,
    suppressedQuiet: 0,
    suppressedCap: 0,
    suppressedDedupe: 0,
    suppressedOptOut: 0,
  };
}

export async function detectPriceAnomalies(
  now: Date = new Date(),
): Promise<DispatchStats> {
  const stats = emptyStats();
  try {
    const watchUsers = await loadWatchlistUsers();
    if (watchUsers.length === 0) return stats;

    const allInstruments = new Set<string>();
    for (const u of watchUsers) for (const sym of u.instruments) allInstruments.add(sym);

    let quotes;
    try {
      quotes = await getLiveQuotes();
    } catch (err) {
      logger.warn({ err }, "live-quotes fetch failed for anomaly detection");
      return stats;
    }
    const priceByInstrument = new Map<string, number>();
    for (const q of quotes.data) {
      const n = typeof q.price === "number" ? q.price : Number(q.price);
      if (Number.isFinite(n)) priceByInstrument.set(q.instrument, n);
    }
    // Update the snapshot ring for every watched instrument so the
    // first detection per (user,instrument) is at most one tick away.
    const nowMs = now.getTime();
    for (const sym of allInstruments) {
      const price = priceByInstrument.get(sym);
      if (price !== undefined) recordSnapshot(sym, price, nowMs);
    }

    // Pre-compute anomaly signals per instrument once per tick — the
    // detection is user-independent; only the cap + opt-out are.
    const signals = new Map<string, AnomalySignal>();
    for (const sym of allInstruments) {
      const price = priceByInstrument.get(sym);
      if (price === undefined) continue;
      const dailyStddev = await getDailyStddevPct(sym);
      const sig = detectAnomaly({
        instrument: sym,
        nowPrice: price,
        now: nowMs,
        dailyStddevPct: dailyStddev,
      });
      if (sig) signals.set(sym, sig);
    }
    stats.candidates = signals.size;
    if (signals.size === 0) return stats;

    const bucket = Math.floor(nowMs / PER_INSTRUMENT_WINDOW_MS);

    for (const user of watchUsers) {
      if (!user.pushPriceAnomaly) {
        stats.suppressedOptOut += 1;
        continue;
      }
      if (withinQuietHours(user, now)) {
        stats.suppressedQuiet += 1;
        continue;
      }

      for (const instrument of user.instruments) {
        const sig = signals.get(instrument);
        if (!sig) continue;

        const daily = await respectFrequencyCap(
          user.id,
          CATEGORY,
          ONE_DAY_MS,
          PER_DAY_CAP,
        );
        if (!daily.allowed) {
          stats.suppressedCap += 1;
          break;
        }

        const dedupeKey = `anomaly:${user.id}:${instrument}:${bucket}`;
        if (await alreadyDelivered(dedupeKey)) {
          stats.suppressedDedupe += 1;
          continue;
        }

        const pctStr = sig.pctMove.toFixed(2);
        const minLabel = sig.windowMinutes === 5 ? "5 menit" : "30 menit";
        const title = `🔥 ${instrument} bergerak ${pctStr}%`;
        const body = `${instrument} bergerak ${pctStr}% dalam ${minLabel} — di atas normal.`;

        const created = await createNotification(
          user.id,
          {
            title,
            message: body,
            type: "warning",
            category: CATEGORY,
            dedupeKey,
          },
          {
            title,
            body,
            url: `/analyze?instrument=${encodeURIComponent(instrument)}`,
            tag: `price-anomaly-${instrument}`,
          },
        );
        if (created) stats.sent += 1;
        else stats.suppressedDedupe += 1;
      }
    }

    logger.info(stats, "detectPriceAnomalies tick");
    return stats;
  } catch (err) {
    logger.error(err, "detectPriceAnomalies failed");
    return stats;
  }
}
