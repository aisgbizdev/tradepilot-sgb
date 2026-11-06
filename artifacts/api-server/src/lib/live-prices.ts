import { logger } from "./logger";
import {
  BINANCE_SYMBOL_MAP,
  CRYPTO_INSTRUMENTS,
  type CryptoInstrument,
} from "./crypto-instruments";

// Shared upstream live-quotes feed. The HTTP route at `/quotes/live` and
// the price-alerts watcher both call into here so they share the same
// 15s in-memory cache (one upstream fetch serves the entire process).
const LIVE_QUOTES_URL = "https://endpoapi-production-3202.up.railway.app/api/live-quotes";

// Binance public ticker for spot crypto. Unauthenticated, free, very
// reliable. We merge its output into the forex/commodity payload so the
// rest of the app (alerts watcher, dashboard ticker, analyze chip) gets
// crypto with zero downstream changes.
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";
const BINANCE_TIMEOUT_MS = 4_000;

// Maps the upstream's opaque symbol codes onto the same instrument names
// the rest of the app uses (the values stored on `analyses.instrument`).
// Kept in lockstep with the table in `routes/quotes.ts`.
const SYMBOL_MAP: Record<string, string> = {
  XUL10: "XAU/USD",
  BCO10_BBJ: "BRENT",
  EU10F_BBJ: "EUR/USD",
  GU10F_BBJ: "GBP/USD",
  UJ10F_BBJ: "USD/JPY",
  UI10F_BBJ: "USD/IDR",
  DX10F_BBJ: "DXY",
  AU10F_BBJ: "AUD/USD",
  // Upstream feeds Hang Seng under the "HK50" alias, but the rest of the
  // app (history filters, journal, analyses, news, calendar) uses the
  // canonical "HSI". Map onto HSI here and emit a duplicate HK50 row in
  // `fetchLive` for the few legacy call sites that still reference HK50.
  HKK50_BBJ: "HSI",
  JPK50_BBJ: "NIKKEI",
};

// Instruments the app supports in the dashboard / analyze flow that
// intentionally have NO live spot mapping in the upstream feed. They're
// futures-only (Yahoo Finance gives us intraday OHLC via CME/COMEX/ICE
// contracts) so `getLivePriceFor` returns null for them and
// `anchorCandlesToLivePrice` no-ops — the displayed price stays on the
// Yahoo futures last-close, which is the most accurate number we have.
// Kept here as explicit documentation so the live-feed coverage test
// can distinguish "missing by design" from "missing by accident".
export const LIVE_PRICE_FUTURES_ONLY: ReadonlySet<string> = new Set([
  "XAG/USD", // COMEX silver futures only
  "DJIA",    // CME E-mini Dow futures only
  "NASDAQ",  // CME E-mini Nasdaq 100 futures only
  "USD/CHF", // No upstream spot feed; Yahoo CHF=X covers intraday
]);

// Canonical instrument list the dashboard/analyze/history surface
// supports. Kept in lockstep with the `ALL_INSTRUMENTS` arrays in
// `artifacts/ai-trading/src/pages/{history,journal}.tsx` and the
// `KNOWN_INSTRUMENTS` set in `routes/user-price-alerts.ts`. Used by
// the live-feed coverage test to assert every supported instrument
// either has a SYMBOL_MAP entry (forex/commodity), a Binance crypto
// mapping, or is documented in LIVE_PRICE_FUTURES_ONLY.
export const SUPPORTED_INSTRUMENTS: readonly string[] = [
  "XAU/USD", "BRENT", "XAG/USD", "HSI", "NIKKEI", "DJIA", "NASDAQ", "DXY",
  "AUD/USD", "EUR/USD", "GBP/USD", "USD/CHF", "USD/JPY", "USD/IDR",
  ...CRYPTO_INSTRUMENTS,
];

// Instruments resolvable from the forex/commodity upstream live-quotes
// feed. Derived from SYMBOL_MAP so the two can't drift.
export const LIVE_FEED_SPOT_INSTRUMENTS: ReadonlySet<string> = new Set(
  Object.values(SYMBOL_MAP),
);

export interface LiveQuote {
  instrument: string;
  symbol: string;
  price: number | string;
  buy?: number | string;
  sell?: number | string;
  spread?: number | string;
  high?: number | string;
  low?: number | string;
  open?: number | string;
  changePercent?: string;
  direction?: "up" | "down";
  serverTime?: string;
  updatedAt?: string;
}

export interface LiveQuotesPayload {
  status: "success";
  updatedAt?: string;
  serverTime?: string;
  data: LiveQuote[];
}

// The active internal market charts poll every five seconds. Keep one shared
// upstream result per process so all connected clients still collapse into at
// most one BBJ request per five-second window.
const CACHE_TTL_MS = 5_000;
let cache: { data: LiveQuotesPayload; fetchedAt: number } | null = null;
let inFlight: Promise<LiveQuotesPayload> | null = null;

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  openPrice: string;
  bidPrice?: string;
  askPrice?: string;
}

/**
 * Fetch Binance 24h tickers for our supported crypto symbols and shape
 * them into the same `LiveQuote` schema we use for forex/commodities.
 * Returns `[]` (not throws) on any error so a Binance outage can't
 * blank out the forex feed for everyone — the dashboard / alerts
 * watcher just sees the crypto rows missing for one cycle.
 */
// Throttle state for the Binance failure log. The fetch runs every ~15s,
// so without this we spam the log with the same message 240×/hour. We
// emit once on first failure (or whenever the failure *changes*) and
// then re-emit at most every 10 minutes while the outage persists.
const BINANCE_WARN_THROTTLE_MS = 10 * 60 * 1000;
let lastBinanceWarnAt = 0;
let lastBinanceWarnKey = "";

function logBinanceFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // HTTP 451 from Binance = "Unavailable For Legal Reasons", i.e. the
  // request region (Replit infra here) is geo-blocked. That's not a
  // transient outage — it's permanent for this environment — so we
  // log it as info with a clearer hint instead of WARN-spam.
  const isGeoBlocked = message.includes("HTTP 451");
  const key = isGeoBlocked ? "geo-blocked" : message;
  const now = Date.now();
  if (key === lastBinanceWarnKey && now - lastBinanceWarnAt < BINANCE_WARN_THROTTLE_MS) {
    return;
  }
  lastBinanceWarnKey = key;
  lastBinanceWarnAt = now;
  if (isGeoBlocked) {
    logger.info(
      { err: message },
      "Binance crypto feed unavailable from this region (HTTP 451) — skipping crypto quotes",
    );
  } else {
    logger.warn({ err: message }, "Binance crypto fetch failed");
  }
}

export async function fetchBinanceCryptoQuotes(): Promise<LiveQuote[]> {
  const reverseMap = new Map<string, CryptoInstrument>();
  for (const inst of CRYPTO_INSTRUMENTS) {
    reverseMap.set(BINANCE_SYMBOL_MAP[inst], inst);
  }
  const symbols = JSON.stringify(Array.from(reverseMap.keys()));
  const url = `${BINANCE_TICKER_URL}?symbols=${encodeURIComponent(symbols)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BINANCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Binance ticker HTTP ${res.status}`);
    }
    const arr = (await res.json()) as BinanceTicker[];
    const out: LiveQuote[] = [];
    for (const t of arr) {
      const instrument = reverseMap.get(t.symbol);
      if (!instrument) continue;
      const pct = Number(t.priceChangePercent);
      const isNeg = pct < 0;
      const sign = isNeg ? "" : "+";
      out.push({
        instrument,
        symbol: t.symbol,
        price: Number(t.lastPrice),
        buy: t.bidPrice ? Number(t.bidPrice) : Number(t.lastPrice),
        sell: t.askPrice ? Number(t.askPrice) : Number(t.lastPrice),
        spread:
          t.bidPrice && t.askPrice
            ? Number((Number(t.askPrice) - Number(t.bidPrice)).toFixed(8))
            : 0,
        high: Number(t.highPrice),
        low: Number(t.lowPrice),
        open: Number(t.openPrice),
        changePercent: `${sign}${pct.toFixed(2)}%`,
        direction: isNeg ? "down" : "up",
      });
    }
    return out;
  } catch (err) {
    logBinanceFailure(err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLive(): Promise<LiveQuotesPayload> {
  // Fetch forex/commodity (required) and crypto (best-effort) in
  // parallel so an extra HTTP round-trip doesn't add latency.
  const [response, cryptoQuotes] = await Promise.all([
    fetch(LIVE_QUOTES_URL),
    fetchBinanceCryptoQuotes(),
  ]);
  if (!response.ok) throw new Error(`Upstream live-quotes error: ${response.status}`);
  const raw = (await response.json()) as { data?: unknown[]; updatedAt?: string; serverTime?: string };
  const mapped: LiveQuote[] = (raw.data ?? []).map((item) => {
    const it = item as Record<string, unknown>;
    const symbol = String(it["symbol"] ?? "");
    const instrument = SYMBOL_MAP[symbol] ?? symbol;
    const changeStr = String(it["change%"] ?? "0%");
    const isNeg = changeStr.startsWith("-");
    return {
      instrument,
      symbol,
      price: it["price"] as number | string,
      buy: it["buy"] as number | string | undefined,
      sell: it["sell"] as number | string | undefined,
      spread: it["spread"] as number | string | undefined,
      high: it["high"] as number | string | undefined,
      low: it["low"] as number | string | undefined,
      open: it["open"] as number | string | undefined,
      changePercent: changeStr,
      direction: isNeg ? "down" : "up",
      serverTime: it["serverTime"] as string | undefined,
      updatedAt: it["serverDateTime"] as string | undefined,
    };
  });
  // Emit a duplicate "HK50" row mirroring the HSI quote so legacy call
  // sites that still reference the upstream alias keep working without
  // a second upstream lookup. The canonical row is HSI (see SYMBOL_MAP).
  const aliasRows: LiveQuote[] = [];
  const hsiRow = mapped.find((q) => q.instrument === "HSI");
  if (hsiRow) {
    aliasRows.push({ ...hsiRow, instrument: "HK50" });
  }
  return {
    status: "success",
    updatedAt: raw.updatedAt,
    serverTime: raw.serverTime,
    data: [...mapped, ...aliasRows, ...cryptoQuotes],
  };
}

/**
 * Fetch the live-quotes payload, sharing a 5s in-memory cache across
 * the HTTP route and the price-alerts watcher. Concurrent callers that
 * hit during a cache miss collapse onto the same in-flight upstream
 * request (so a burst doesn't fan out into N upstream calls).
 */
export async function getLiveQuotes(): Promise<LiveQuotesPayload> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inFlight) return inFlight;
  inFlight = fetchLive()
    .then((data) => {
      cache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Resolve the current mid-price for a single instrument. Returns null
 * when the upstream feed doesn't cover that instrument (the watcher
 * treats those alerts as un-checkable and leaves them armed until
 * `validUntil` cancels them out).
 */
export async function getLivePriceFor(instrument: string): Promise<number | null> {
  try {
    const payload = await getLiveQuotes();
    const hit = payload.data.find((q) => q.instrument === instrument);
    if (!hit) return null;
    const n = typeof hit.price === "number" ? hit.price : Number(hit.price);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    logger.warn({ err, instrument }, "Live-price lookup failed");
    return null;
  }
}
