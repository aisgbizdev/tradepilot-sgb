import {
  calculateIndicators,
  type TechnicalIndicators,
  type Candle,
} from "./indicators.js";
import {
  isCryptoInstrument,
  yahooCryptoSymbolFor,
} from "./crypto-instruments.js";
import { getLivePriceFor } from "./live-prices.js";
import { VERIFIED_OTHER_INSTRUMENTS } from "./verified-instruments.js";

const HISTORICAL_API =
  "https://endpoapi-production-3202.up.railway.app/api/historical";
// Yahoo Finance's chart endpoint. Public, unauthenticated, widely used as a
// free intraday OHLC source for forex, futures, and indices. We send a
// browser-like User-Agent because the host occasionally rejects the default
// Node.js fetch UA.
const YAHOO_CHART_API = "https://query2.finance.yahoo.com/v8/finance/chart";
const YAHOO_USER_AGENT =
  "Mozilla/5.0 (compatible; AITradingAssistant/1.0; +https://aitradingassistant.app)";

// Daily upstream symbol map (used for 1D / 1W).
// Note: the upstream daily feed only carries the symbols below. Other
// instruments (XAG/USD, USD/IDR, DXY, DJIA, NASDAQ) have intraday-only
// coverage via Yahoo Finance — selecting 1D/1W for them returns null.
const SYMBOL_MAP: Record<string, string> = {
  "XAU/USD": "LGD Daily",
  BRENT: "BCO Daily",
  "EUR/USD": "EUR/USD",
  "GBP/USD": "GBP/USD",
  "USD/JPY": "USD/JPY",
  "USD/CHF": "USD/CHF",
  "AUD/USD": "AUD/USD",
  HSI: "HSI Daily",
  NIKKEI: "SNI Daily",
};

// Per-instrument Yahoo Finance symbol used for intraday OHLC. Choose the most
// liquid contract available so the candles reflect real intraday price action:
//   - XAU/USD → COMEX gold futures (GC=F)
//   - XAG/USD → COMEX silver futures (SI=F)
//   - BRENT   → ICE Brent crude futures (BZ=F)
//   - HSI     → Hang Seng Index spot (^HSI)
//   - NIKKEI  → CME yen-denominated Nikkei 225 futures (NIY=F) — trades during
//               US hours, gives Yahoo a usable intraday series
//   - DJIA    → CME E-mini Dow futures (YM=F)
//   - NASDAQ  → CME E-mini Nasdaq 100 futures (NQ=F)
//   - DXY     → ICE US Dollar Index spot (DX-Y.NYB)
//   - Forex   → Yahoo's spot FX symbols (e.g. EURUSD=X, JPY=X, IDR=X)
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  "XAU/USD": "GC=F",
  "XAG/USD": "SI=F",
  BRENT: "BZ=F",
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "JPY=X",
  "USD/CHF": "CHF=X",
  "AUD/USD": "AUDUSD=X",
  "USD/IDR": "IDR=X",
  HSI: "^HSI",
  NIKKEI: "NIY=F",
  DJIA: "YM=F",
  NASDAQ: "NQ=F",
  DXY: "DX-Y.NYB",
};

export type IntradayTimeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h";
export type DailyTimeframe = "1D" | "1W";
export type IndicatorTimeframe = IntradayTimeframe | DailyTimeframe;

export const INTRADAY_TIMEFRAMES: IntradayTimeframe[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
];
export const SUPPORTED_INDICATOR_TIMEFRAMES: IndicatorTimeframe[] = [
  ...INTRADAY_TIMEFRAMES,
  "1D",
  "1W",
];

export function isSupportedIndicatorTimeframe(
  tf: string,
): tf is IndicatorTimeframe {
  return (SUPPORTED_INDICATOR_TIMEFRAMES as string[]).includes(tf);
}

function isIntradayTimeframe(tf: IndicatorTimeframe): tf is IntradayTimeframe {
  return (INTRADAY_TIMEFRAMES as string[]).includes(tf);
}

let dailyCache: { data: any; fetchedAt: number } | null = null;
const DAILY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchAllHistorical(): Promise<{
  data: any[];
  fetchedAt: number;
}> {
  if (dailyCache && Date.now() - dailyCache.fetchedAt < DAILY_CACHE_TTL) {
    return { data: dailyCache.data, fetchedAt: dailyCache.fetchedAt };
  }
  const dateFrom = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const res = await fetch(`${HISTORICAL_API}?dateFrom=${dateFrom}`);
  if (!res.ok) throw new Error("Failed to fetch historical data");
  const json = (await res.json()) as { data: any };
  dailyCache = { data: json.data, fetchedAt: Date.now() };
  return { data: dailyCache.data, fetchedAt: dailyCache.fetchedAt };
}

// Per-(instrument, timeframe) cache for the resampled candles + computed
// indicators. Daily entries are keyed by the upstream `fetchedAt` so they get
// invalidated whenever the underlying daily cache refreshes; intraday entries
// rely solely on a short TTL.
type CachedIndicators = {
  indicators: TechnicalIndicators;
  computedAt: number;
  // Only set for daily/weekly entries derived from the upstream cache. When
  // present we additionally require this to match the current upstream
  // fetchedAt before serving the cached value.
  sourceFetchedAt?: number;
};
const indicatorsCache = new Map<string, CachedIndicators>();

// TTLs are tuned per timeframe so the toggle stays snappy without serving
// stale intraday data: shorter horizons refresh more often than long ones.
const INDICATORS_CACHE_TTL_MS: Record<IndicatorTimeframe, number> = {
  "1m": 30 * 1000,
  "5m": 60 * 1000,
  "15m": 3 * 60 * 1000,
  "30m": 4 * 60 * 1000,
  "1h": 5 * 60 * 1000,
  "4h": 15 * 60 * 1000,
  "1D": 10 * 60 * 1000,
  "1W": 10 * 60 * 1000,
};

// When the upstream OHLC source (Yahoo Finance / daily feed) is failing, we
// keep serving the most recently computed indicators rather than collapsing
// to "no data" in the UI. This caps how stale that fallback is allowed to be:
// 6× the normal TTL (e.g. ~3 min for 1m, ~30 min for 5m, ~30 min for 1h, ~1h
// for 4h/daily). Beyond this we treat the data as too old to be useful and
// surface the failure as null so the UI can show a fresh-data error state.
const STALE_FALLBACK_MULTIPLIER = 6;

export function indicatorsCacheTtlSeconds(
  timeframe: IndicatorTimeframe,
): number {
  return Math.floor(INDICATORS_CACHE_TTL_MS[timeframe] / 1000);
}

function indicatorsCacheKey(
  instrument: string,
  timeframe: IndicatorTimeframe,
): string {
  return `${instrument}|${timeframe}`;
}

// Exposed for tests / manual cache busting.
export function clearIndicatorsCache(): void {
  indicatorsCache.clear();
  dailyCache = null;
  candlesCache.clear();
  candleRequests.clear();
  yahooRequests.clear();
  candleFailureUntil.clear();
}

// Aggregate daily candles into ISO-week (Mon–Sun) candles. Each weekly bar uses
// the first day's open, highest high, lowest low, and last day's close.
function resampleDailyToWeekly(daily: Candle[]): Candle[] {
  if (daily.length === 0) return [];
  const sorted = [...daily].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const weekKeyOf = (iso: string): string => {
    const d = new Date(iso);
    // Find Monday of this date's ISO week (UTC to avoid TZ drift).
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() + diffToMonday,
      ),
    );
    return monday.toISOString().slice(0, 10);
  };

  const buckets = new Map<string, Candle[]>();
  for (const c of sorted) {
    const key = weekKeyOf(c.date);
    const arr = buckets.get(key) ?? [];
    arr.push(c);
    buckets.set(key, arr);
  }

  const weeks: Candle[] = [];
  for (const key of [...buckets.keys()].sort()) {
    const group = buckets.get(key)!;
    weeks.push({
      date: group[group.length - 1].date,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
    });
  }
  return weeks;
}

// Bucket 1h candles into 4h candles aligned to UTC (0–4, 4–8, 8–12, 12–16, 16–20, 20–24).
// We pick UTC alignment because Yahoo timestamps are absolute (epoch seconds)
// and a UTC grid keeps the bucket boundaries stable across DST shifts.
function resampleHourlyToFourHour(hourly: Candle[]): Candle[] {
  if (hourly.length === 0) return [];
  const sorted = [...hourly].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const FOUR_H_MS = 4 * 60 * 60 * 1000;
  const buckets = new Map<number, Candle[]>();
  for (const c of sorted) {
    const ts = new Date(c.date).getTime();
    const bucket = Math.floor(ts / FOUR_H_MS) * FOUR_H_MS;
    const arr = buckets.get(bucket) ?? [];
    arr.push(c);
    buckets.set(bucket, arr);
  }

  const out: Candle[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const group = buckets.get(key)!;
    out.push({
      date: new Date(key).toISOString(),
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
    });
  }
  return out;
}

// Map our intraday timeframes to (Yahoo interval, range) pairs. Ranges are
// chosen to comfortably exceed a 200-period SMA on each timeframe so every
// indicator the panel computes returns a value.
const YAHOO_INTRADAY_PARAMS: Record<
  IntradayTimeframe,
  { interval: string; range: string }
> = {
  "1m": { interval: "1m", range: "7d" }, // ~10k candles (max Yahoo allows for 1m)
  "5m": { interval: "5m", range: "60d" }, // ~5k candles
  "15m": { interval: "15m", range: "60d" }, // ~1.7k candles
  "30m": { interval: "30m", range: "60d" }, // ~880 candles — Yahoo supports 30m natively
  "1h": { interval: "60m", range: "730d" }, // ~3k candles
  // 4h is not a native Yahoo interval — we fetch 1h with a long range and
  // resample below to 4h buckets.
  "4h": { interval: "60m", range: "730d" },
};

interface YahooChartResult {
  meta: { symbol: string; exchangeTimezoneName?: string };
  timestamp?: number[];
  indicators: {
    quote: Array<{
      open: (number | null)[];
      high: (number | null)[];
      low: (number | null)[];
      close: (number | null)[];
    }>;
  };
}

// Marker class for failures we should retry once. We treat network errors,
// timeouts (AbortError), and Yahoo 5xx / 429 responses as transient. Anything
// else (4xx, malformed JSON, chart.error) is treated as terminal because a
// retry won't change the outcome.
class TransientYahooError extends Error {}

async function fetchYahooCandlesOnce(
  yahooSymbol: string,
  interval: string,
  range: string,
): Promise<Candle[]> {
  const url =
    `${YAHOO_CHART_API}/${encodeURIComponent(yahooSymbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  // Bound the upstream call so a slow/hanging Yahoo request can't tie up the
  // event loop indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": YAHOO_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err: any) {
    // Network errors and timeouts are always retryable. Node's fetch (undici)
    // only reports "fetch failed" as the message; the real reason (ETIMEDOUT,
    // ENETUNREACH, ECONNRESET, ...) lives in err.cause, so surface it for
    // diagnosing IPv6 / happy-eyeballs vs. blocking problems.
    const cause = err?.cause;
    const causeCode = cause?.code ?? cause?.errors?.[0]?.code;
    const causeMsg = cause?.message ? String(cause.message).slice(0, 120) : "";
    const causeInfo = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(" ")})` : "";
    throw new TransientYahooError(
      `Yahoo Finance fetch failed for ${yahooSymbol}: ${err?.name ?? "Error"} ${err?.message ?? ""}${causeInfo}`.trim(),
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) {
      throw new TransientYahooError(
        `Yahoo Finance returned ${res.status} for ${yahooSymbol}`,
      );
    }
    throw new Error(`Yahoo Finance returned ${res.status} for ${yahooSymbol}`);
  }
  const json = (await res.json()) as {
    chart?: {
      result?: YahooChartResult[];
      error?: { code?: string; description?: string } | null;
    };
  };
  if (json.chart?.error) {
    throw new Error(
      `Yahoo Finance error for ${yahooSymbol}: ${json.chart.error.description ?? json.chart.error.code ?? "unknown"}`,
    );
  }
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return [];

  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i];
    const h = q.high[i];
    const l = q.low[i];
    const c = q.close[i];
    // Yahoo can include partial bars at the very end with all-null OHLC; skip
    // those so they don't poison indicator calculations.
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({
      date: new Date(ts[i] * 1000).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
    });
  }
  return candles;
}

// Tunable retry knobs. Exported so tests can shrink the backoff and avoid
// adding seconds of wall-clock time to the suite.
export const YAHOO_RETRY_CONFIG = {
  maxRetries: 1,
  backoffMs: 500,
};

async function fetchYahooCandlesUnshared(
  yahooSymbol: string,
  interval: string,
  range: string,
): Promise<Candle[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= YAHOO_RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await fetchYahooCandlesOnce(yahooSymbol, interval, range);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof TransientYahooError)) {
        throw err;
      }
      if (attempt < YAHOO_RETRY_CONFIG.maxRetries) {
        // Tiny jittered backoff so a burst of failures doesn't all retry in
        // lockstep. Backoff is short on purpose — Yahoo errors are usually
        // either instantly recoverable or persistent for many seconds.
        const jitter = Math.floor(Math.random() * 100);
        await new Promise((r) =>
          setTimeout(r, YAHOO_RETRY_CONFIG.backoffMs + jitter),
        );
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Yahoo Finance fetch failed for ${yahooSymbol}`);
}

const yahooRequests = new Map<string, Promise<Candle[]>>();
function fetchYahooCandles(
  yahooSymbol: string,
  interval: string,
  range: string,
): Promise<Candle[]> {
  const key = `${yahooSymbol}|${interval}|${range}`;
  const existing = yahooRequests.get(key);
  if (existing) return existing;
  const request = fetchYahooCandlesUnshared(yahooSymbol, interval, range);
  yahooRequests.set(key, request);
  void request.then(
    () => {
      if (yahooRequests.get(key) === request) yahooRequests.delete(key);
    },
    () => {
      if (yahooRequests.get(key) === request) yahooRequests.delete(key);
    },
  );
  return request;
}

async function getIntradayCandles(
  instrument: string,
  timeframe: IntradayTimeframe,
): Promise<Candle[] | null> {
  // Crypto: Yahoo carries BTC-USD / ETH-USD / etc. on the same chart
  // endpoint we already use for forex futures, so we just resolve the
  // symbol differently and reuse the rest of the pipeline.
  const yahooSymbol =
    yahooCryptoSymbolFor(instrument) ?? YAHOO_SYMBOL_MAP[instrument];
  if (!yahooSymbol) return null;

  const params = YAHOO_INTRADAY_PARAMS[timeframe];
  const raw = await fetchYahooCandles(
    yahooSymbol,
    params.interval,
    params.range,
  );
  if (raw.length === 0) return [];

  // 4h uses 1h data resampled into UTC-aligned 4-hour buckets.
  return timeframe === "4h" ? resampleHourlyToFourHour(raw) : raw;
}

// Crypto daily/weekly via Yahoo. The upstream daily feed used for forex
// & commodities doesn't carry crypto, so we go direct to Yahoo's 1d
// interval and (for 1W) resample with the same Mon–Sun bucketing rule
// used everywhere else. Range of 2y comfortably exceeds the 200-period
// SMA on daily, and ~5y for weekly.
const YAHOO_DAILY_PARAMS: Record<
  DailyTimeframe,
  { interval: string; range: string }
> = {
  "1D": { interval: "1d", range: "2y" },
  "1W": { interval: "1d", range: "5y" },
};

async function getCryptoDailyCandles(
  instrument: string,
  timeframe: DailyTimeframe,
): Promise<Candle[] | null> {
  const yahooSymbol = yahooCryptoSymbolFor(instrument);
  if (!yahooSymbol) return null;
  const params = YAHOO_DAILY_PARAMS[timeframe];
  const raw = await fetchYahooCandles(
    yahooSymbol,
    params.interval,
    params.range,
  );
  if (raw.length === 0) return [];
  return timeframe === "1W" ? resampleDailyToWeekly(raw) : raw;
}

async function getDailyCandles(
  instrument: string,
  timeframe: DailyTimeframe,
): Promise<{ candles: Candle[]; sourceFetchedAt: number } | null> {
  // The shared daily feed's FX rows arrive newest-first and some of its
  // prices materially diverge from both Yahoo spot and the live broker quote.
  // Use the same Yahoo spot identity as intraday for newly admitted FX pairs.
  if (VERIFIED_OTHER_INSTRUMENTS.has(instrument)) {
    const yahooSymbol = YAHOO_SYMBOL_MAP[instrument];
    const params = YAHOO_DAILY_PARAMS[timeframe];
    const raw = await fetchYahooCandles(
      yahooSymbol,
      params.interval,
      params.range,
    );
    if (!raw.length) return null;
    return {
      candles: timeframe === "1W" ? resampleDailyToWeekly(raw) : raw,
      sourceFetchedAt: Date.now(),
    };
  }
  // Crypto goes straight to Yahoo (the forex/commodity daily feed
  // doesn't carry it). Each call is its own snapshot, so we synth a
  // `sourceFetchedAt` from the current clock — the cache TTL still
  // bounds staleness, we just lose the cross-instrument pinning we get
  // from the shared daily blob (acceptable, crypto trades 24/7 anyway).
  if (isCryptoInstrument(instrument)) {
    const cryptoCandles = await getCryptoDailyCandles(instrument, timeframe);
    if (!cryptoCandles) return null;
    return { candles: cryptoCandles, sourceFetchedAt: Date.now() };
  }

  const apiSymbol = SYMBOL_MAP[instrument];
  if (!apiSymbol) return null;

  const { data: allData, fetchedAt: sourceFetchedAt } =
    await fetchAllHistorical();
  const symbolData = allData.find((s: any) => s.symbol === apiSymbol);
  if (!symbolData || !symbolData.data?.length) return null;

  // The shared daily feed's rows arrive newest-first (see the VERIFIED_OTHER_
  // INSTRUMENTS branch above) — every consumer of this array (chart
  // rendering, the live-price anchor, the D1/1W market-snapshot capture in
  // routes/analyses.ts) assumes the LAST element is the most recent candle,
  // same convention as the Yahoo-sourced paths. Sort ascending here once so
  // that assumption actually holds, instead of only being true by accident
  // for instruments that happen to go through resampleDailyToWeekly (which
  // already sorts internally) or the Yahoo branch above.
  const dailyCandles: Candle[] = symbolData.data
    .map((d: any) => ({
      date: d.date,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
    }))
    .sort(
      (a: Candle, b: Candle) =>
        new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

  const candles =
    timeframe === "1W" ? resampleDailyToWeekly(dailyCandles) : dailyCandles;
  return { candles, sourceFetchedAt };
}

// Anchor the OHLC series to the same live spot/feed price the dashboard
// ticker shows so the "Price" displayed in Technical Indicators (and the
// number fed to the AI prompt + Suggested Levels) matches what the user
// sees everywhere else. Background: indicators are computed from Yahoo
// Finance OHLC, which for XAU/USD is GC=F (gold futures), but the live
// ticker uses XUL10 (spot). Spot vs futures carries a basis spread that
// can be 20+ points on gold — large enough that the analysis price
// looks visibly wrong next to the ticker.
//
// We shift every candle by a single offset (live_price − last_close).
// Because indicators only depend on relative price movement (MAs,
// signals, % changes), applying the same constant shift to every bar
// leaves all signals and changes IDENTICAL — only the displayed price
// levels (`lastClose`, MA values, Bollinger bands) re-anchor onto the
// live feed. If the offset looks pathological (> 5% of last close)
// we skip — almost certainly a bad live-feed value, and keeping the
// raw Yahoo prices is the safer fallback.
async function anchorCandlesToLivePrice(
  instrument: string,
  candles: Candle[],
): Promise<Candle[]> {
  if (candles.length === 0) return candles;
  const lastClose = candles[candles.length - 1].close;
  if (!Number.isFinite(lastClose) || lastClose <= 0) return candles;
  let livePrice: number | null = null;
  try {
    livePrice = await getLivePriceFor(instrument);
  } catch {
    return candles;
  }
  if (livePrice === null || !Number.isFinite(livePrice) || livePrice <= 0) {
    return candles;
  }
  const offset = livePrice - lastClose;
  // Tiny offsets aren't worth the alloc — same instrument feed (e.g.
  // EUR/USD spot vs Yahoo's EURUSD=X spot) typically lines up to within
  // a fraction of a pip.
  if (Math.abs(offset) < 1e-6) return candles;
  // Sanity: a >5% shift means one of the two feeds is broken; trust
  // Yahoo and skip the anchor so we don't surface nonsense prices.
  if (Math.abs(offset) / lastClose > 0.05) return candles;
  return candles.map((c) => ({
    date: c.date,
    open: c.open + offset,
    high: c.high + offset,
    low: c.low + offset,
    close: c.close + offset,
  }));
}

// If the upstream is unavailable but we still have a "recent enough" cached
// indicator entry, return it instead of surfacing null. Recent enough = within
// STALE_FALLBACK_MULTIPLIER × the timeframe's normal TTL.
function staleFallback(
  cached: CachedIndicators | undefined,
  timeframe: IndicatorTimeframe,
): TechnicalIndicators | null {
  if (!cached) return null;
  const maxAge = INDICATORS_CACHE_TTL_MS[timeframe] * STALE_FALLBACK_MULTIPLIER;
  if (Date.now() - cached.computedAt > maxAge) return null;
  return cached.indicators;
}

export async function getIndicators(
  instrument: string,
  timeframe: IndicatorTimeframe = "1D",
): Promise<TechnicalIndicators | null> {
  const cacheKey = indicatorsCacheKey(instrument, timeframe);
  const cached = indicatorsCache.get(cacheKey);
  const ttl = INDICATORS_CACHE_TTL_MS[timeframe];

  if (isIntradayTimeframe(timeframe)) {
    // Pure TTL cache for intraday — there's no shared upstream snapshot to
    // pin against, and short TTLs already bound staleness.
    if (cached && Date.now() - cached.computedAt < ttl) {
      return cached.indicators;
    }
    let candles: Candle[] | null;
    try {
      const source = candlesCache.get(cacheKey);
      if (source && Date.now() - source.sourceFetchedAt < ttl) {
        candles = source.candles;
      } else {
        candles = await getIntradayCandles(instrument, timeframe);
        if (candles?.length)
          candlesCache.set(cacheKey, { candles, sourceFetchedAt: Date.now() });
      }
    } catch (err) {
      console.warn(
        `[historical] intraday fetch failed for ${instrument} ${timeframe}; using stale cache if available`,
        err instanceof Error ? err.message : err,
      );
      return staleFallback(cached, timeframe);
    }
    if (!candles || !candles.length) {
      // Empty result is treated like a soft failure — same fallback policy.
      return staleFallback(cached, timeframe);
    }
    const anchored = await anchorCandlesToLivePrice(instrument, candles);
    const indicators = calculateIndicators(instrument, anchored, timeframe);
    indicatorsCache.set(cacheKey, { indicators, computedAt: Date.now() });
    return indicators;
  }

  // Daily / weekly path — pin cache entries to the upstream snapshot so we
  // never serve indicators computed from raw data that has since refreshed.
  let dailyResult: Awaited<ReturnType<typeof getDailyCandles>>;
  try {
    dailyResult = await getDailyCandles(instrument, timeframe);
  } catch (err) {
    console.warn(
      `[historical] daily fetch failed for ${instrument} ${timeframe}; using stale cache if available`,
      err instanceof Error ? err.message : err,
    );
    return staleFallback(cached, timeframe);
  }
  if (!dailyResult) return null;
  const { candles, sourceFetchedAt } = dailyResult;

  if (
    cached &&
    cached.sourceFetchedAt === sourceFetchedAt &&
    Date.now() - cached.computedAt < ttl
  ) {
    return cached.indicators;
  }

  if (!candles.length) return staleFallback(cached, timeframe);
  const anchored = await anchorCandlesToLivePrice(instrument, candles);
  const indicators = calculateIndicators(instrument, anchored, timeframe);
  indicatorsCache.set(cacheKey, {
    indicators,
    computedAt: Date.now(),
    sourceFetchedAt,
  });
  return indicators;
}

export type CandleSnapshot = {
  candles: Candle[];
  sourceFetchedAt: string;
  sourceMaxAgeMs: number;
  isStale: boolean;
  staleReason: "source_age" | "feed_unavailable" | null;
};

class EmptyCandleFeedError extends Error {}

type CachedCandles = { candles: Candle[]; sourceFetchedAt: number };
const candlesCache = new Map<string, CachedCandles>();
const candleRequests = new Map<string, Promise<CandleSnapshot | null>>();
const candleFailureUntil = new Map<string, number>();
const CANDLE_FAILURE_COOLDOWN_MS = 3_000;

// The daily feed is shared for one hour. Its age limit must reflect that
// upstream cache, not the shorter indicators computation cache.
function candleSourceMaxAge(timeframe: IndicatorTimeframe): number {
  return isIntradayTimeframe(timeframe)
    ? INDICATORS_CACHE_TTL_MS[timeframe]
    : DAILY_CACHE_TTL;
}

async function candleSnapshot(
  cached: CachedCandles,
  maxAge: number,
  feedUnavailable = false,
  instrument: string,
): Promise<CandleSnapshot> {
  const isOld = Date.now() - cached.sourceFetchedAt >= maxAge;
  return {
    // The OHLC source snapshot and the live spot price are independent.
    // Re-anchor at read time so cached bars don't freeze the displayed level.
    candles: await anchorCandlesToLivePrice(instrument, cached.candles),
    sourceFetchedAt: new Date(cached.sourceFetchedAt).toISOString(),
    sourceMaxAgeMs: maxAge,
    isStale: feedUnavailable || isOld,
    staleReason: feedUnavailable
      ? "feed_unavailable"
      : isOld
        ? "source_age"
        : null,
  };
}

// The timestamp records a successful upstream retrieval, never a cache read
// or the separate live-price anchor. On failure a bounded cached snapshot can
// still be displayed, but it is explicitly marked stale for Adaptive.
async function loadCandleSnapshot(
  instrument: string,
  timeframe: IndicatorTimeframe,
): Promise<CandleSnapshot | null> {
  const key = indicatorsCacheKey(instrument, timeframe);
  const cached = candlesCache.get(key);
  const maxAge = candleSourceMaxAge(timeframe);
  if (cached && Date.now() - cached.sourceFetchedAt < maxAge) {
    return candleSnapshot(cached, maxAge, false, instrument);
  }
  if ((candleFailureUntil.get(key) ?? 0) > Date.now()) {
    if (cached) return candleSnapshot(cached, maxAge, true, instrument);
    throw new Error("Candle source temporarily unavailable");
  }
  try {
    const result = isIntradayTimeframe(timeframe)
      ? {
          candles: await getIntradayCandles(instrument, timeframe),
          sourceFetchedAt: Date.now(),
        }
      : await getDailyCandles(instrument, timeframe);
    if (!result) return null;
    if (!result.candles?.length)
      throw new EmptyCandleFeedError("Empty candle feed");
    // Cache raw bars, not live-price adjusted ones. Anchoring changes on each
    // request while the OHLC source timestamp stays fixed until its next fetch.
    const next = {
      candles: result.candles,
      sourceFetchedAt: result.sourceFetchedAt,
    };
    candlesCache.set(key, next);
    candleFailureUntil.delete(key);
    return candleSnapshot(next, maxAge, false, instrument);
  } catch (err) {
    candleFailureUntil.set(key, Date.now() + CANDLE_FAILURE_COOLDOWN_MS);
    if (
      cached &&
      Date.now() - cached.sourceFetchedAt < maxAge * STALE_FALLBACK_MULTIPLIER
    ) {
      return candleSnapshot(cached, maxAge, true, instrument);
    }
    throw err;
  }
}

export function getCandleSnapshot(
  instrument: string,
  timeframe: IndicatorTimeframe,
): Promise<CandleSnapshot | null> {
  const key = indicatorsCacheKey(instrument, timeframe);
  const existing = candleRequests.get(key);
  if (existing) return existing;
  const request = loadCandleSnapshot(instrument, timeframe);
  candleRequests.set(key, request);
  void request.then(
    () => {
      if (candleRequests.get(key) === request) candleRequests.delete(key);
    },
    () => {
      if (candleRequests.get(key) === request) candleRequests.delete(key);
    },
  );
  return request;
}

// Retain the existing array API for chart and internal consumers.
export async function getCandles(
  instrument: string,
  timeframe: IndicatorTimeframe,
): Promise<Candle[] | null> {
  try {
    return (await getCandleSnapshot(instrument, timeframe))?.candles ?? null;
  } catch (err) {
    // Legacy indicator/outcome consumers use [] to distinguish an empty
    // upstream series from a transport failure; keep that array contract.
    if (err instanceof EmptyCandleFeedError) return [];
    throw err;
  }
}

// Human-readable Indonesian unit/period labels for prompt + UI alignment.
function timeframeLabels(tf: IndicatorTimeframe): {
  candleUnit: string;
  periodLabel: string;
} {
  switch (tf) {
    case "1m":
      return { candleUnit: "candle 1 menit", periodLabel: "candle 1m" };
    case "5m":
      return { candleUnit: "candle 5 menit", periodLabel: "candle 5m" };
    case "15m":
      return { candleUnit: "candle 15 menit", periodLabel: "candle 15m" };
    case "30m":
      return { candleUnit: "candle 30 menit", periodLabel: "candle 30m" };
    case "1h":
      return { candleUnit: "candle 1 jam", periodLabel: "candle 1h" };
    case "4h":
      return { candleUnit: "candle 4 jam", periodLabel: "candle 4h" };
    case "1W":
      return { candleUnit: "candle mingguan", periodLabel: "minggu" };
    case "1D":
    default:
      return { candleUnit: "candle harian", periodLabel: "hari" };
  }
}

export function formatIndicatorsForPrompt(
  ind: TechnicalIndicators,
  timeframe: IndicatorTimeframe = "1D",
): string {
  const r = (n: number, decimals = 2) => n.toFixed(decimals);
  const sign = (n: number) => (n >= 0 ? "+" : "") + r(n);

  const maLines = ind.movingAverages
    .sort((a, b) => a.period - b.period || a.type.localeCompare(b.type))
    .map((m) => `  ${m.type}(${m.period}): ${r(m.value, 4)} → ${m.signal}`)
    .join("\n");

  const { candleUnit, periodLabel } = timeframeLabels(timeframe);

  return `
=== DATA TEKNIKAL (${ind.symbol}, timeframe ${timeframe}, berdasarkan ${ind.dataPoints} ${candleUnit}) ===
Harga terakhir: ${r(ind.lastClose, 4)} (${ind.lastDate})
Perubahan (per ${periodLabel}): 1=${sign(ind.change1dPct)}% | 5=${sign(ind.change5dPct)}% | 20=${sign(ind.change20dPct)}%

RINGKASAN SINYAL (timeframe ${timeframe}):
  Oscillator: ${ind.oscillatorSummary.buy} Beli / ${ind.oscillatorSummary.sell} Jual / ${ind.oscillatorSummary.neutral} Netral
  Moving Average: ${ind.maSummary.buy} Beli / ${ind.maSummary.sell} Jual / ${ind.maSummary.neutral} Netral
  KESELURUHAN: ${ind.overallSummary.buy} Beli / ${ind.overallSummary.sell} Jual / ${ind.overallSummary.neutral} Netral → ${ind.overallSummary.signal.toUpperCase()}

OSCILLATOR (timeframe ${timeframe}):
  RSI(14): ${r(ind.rsi14.value)} → ${ind.rsi14.signal}
  MACD(12,26,9): garis=${r(ind.macd.macd, 4)} signal=${r(ind.macd.signal, 4)} histogram=${r(ind.macd.histogram, 4)} → ${ind.macd.action}
  Stochastic(14,3,3): %K=${r(ind.stochastic.k)} %D=${r(ind.stochastic.d)} → ${ind.stochastic.signal}
  Bollinger Bands(20,2): upper=${r(ind.bollinger.upper, 4)} mid=${r(ind.bollinger.middle, 4)} lower=${r(ind.bollinger.lower, 4)} → ${ind.bollinger.signal}

MOVING AVERAGES (timeframe ${timeframe}):
${maLines}
===`;
}
