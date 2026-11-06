// Yahoo Finance per-symbol RSS adapter. Public, no API key. Used as a
// second fundamental-news source alongside Newsmaker.id. Yahoo returns
// empty <channel> for unknown symbols rather than 4xx, so the caller
// treats no-items as no-upstream-data, never as a hard error.

const YAHOO_RSS_BASE =
  "https://feeds.finance.yahoo.com/rss/2.0/headline";

// Yahoo uses `=F` for futures and `=X` for FX crosses. Unmapped
// instruments fall back to `getYahooFinanceMacroNews`.
const INSTRUMENT_TO_YAHOO_SYMBOL: Record<string, string> = {
  "XAU/USD": "GC=F",
  "XAG/USD": "SI=F",
  "BRENT": "BZ=F",
  "EUR/USD": "EURUSD=X",
  "GBP/USD": "GBPUSD=X",
  "USD/JPY": "JPY=X",
  "USD/IDR": "IDR=X",
  "DXY": "DX-Y.NYB",
  "AUD/USD": "AUDUSD=X",
  "USD/CHF": "CHF=X",
  "HSI": "^HSI",
  "NIKKEI": "^N225",
  "DJIA": "^DJI",
  "NASDAQ": "^IXIC",
  // Crypto: Yahoo serves per-symbol headlines under the same RSS shape
  // we use for FX, just with `BTC-USD` etc. as the symbol.
  "BTC/USD": "BTC-USD",
  "ETH/USD": "ETH-USD",
  "SOL/USD": "SOL-USD",
  "BNB/USD": "BNB-USD",
  "XRP/USD": "XRP-USD",
};

export interface YahooRawItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

const cache = new Map<string, { fetchedAt: number; items: YahooRawItem[] }>();
const CACHE_TTL = 10 * 60 * 1000;

/**
 * Decode the small handful of HTML entities Yahoo's RSS actually emits
 * (it doesn't use the full HTML entity set). Keeping this minimal and
 * dependency-free avoids pulling a parser like fast-xml-parser just for
 * a couple feeds.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripCdata(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return trimmed.slice(9, -3).trim();
  }
  return trimmed;
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  return decodeEntities(stripCdata(m[1] ?? "")).trim();
}

/**
 * Parse a Yahoo Finance RSS 2.0 payload into raw item shapes. Kept
 * regex-based on purpose — Yahoo's feed is well-formed and a streaming
 * parser would be overkill (≤ 30 items per call).
 */
export function parseYahooRss(xml: string): YahooRawItem[] {
  const items: YahooRawItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const description = extractTag(block, "description");
    // Strip any leftover HTML tags from description (Yahoo sometimes
    // wraps a thumbnail <img> + text in description).
    const cleanDescription = description.replace(/<[^>]+>/g, "").trim();
    if (title && link) {
      items.push({ title, link, pubDate, description: cleanDescription });
    }
  }
  return items;
}

async function fetchYahooFeed(symbol: string): Promise<YahooRawItem[]> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.items;
  }
  const url = `${YAHOO_RSS_BASE}?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
  let xml = "";
  try {
    const res = await fetch(url, {
      headers: {
        // Yahoo's RSS edge sometimes returns 403 to blank UAs.
        "User-Agent": "TradePilot/1.0 (+https://trade-pilot.app)",
        "Accept": "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) {
      cache.set(symbol, { fetchedAt: Date.now(), items: [] });
      return [];
    }
    xml = await res.text();
  } catch {
    cache.set(symbol, { fetchedAt: Date.now(), items: [] });
    return [];
  }
  const items = parseYahooRss(xml);
  cache.set(symbol, { fetchedAt: Date.now(), items });
  return items;
}

export interface YahooNewsItem {
  title: string;
  summary: string;
  url: string;
  publishedAt: string; // ISO 8601, best-effort
}

// Sentinel for missing / unparseable upstream dates. Mirrors the same
// approach in `news.ts`: tagging undated items as the epoch lets the
// 7-day recency filter drop them automatically, instead of letting an
// undated item slip through by being coerced to `now`.
const UNDATED_SENTINEL = new Date(0).toISOString();

function toIsoDate(input: string): string {
  if (!input) return UNDATED_SENTINEL;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return UNDATED_SENTINEL;
  return d.toISOString();
}

/**
 * Fetch up to `maxItems` per-instrument headlines from Yahoo Finance.
 * Returns an empty array (never throws) if the feed is empty, the
 * upstream is down, or the symbol is not mapped — the caller will fall
 * back to other sources.
 */
export async function getYahooFinanceNews(
  instrument: string,
  maxItems = 8,
): Promise<YahooNewsItem[]> {
  const symbol = INSTRUMENT_TO_YAHOO_SYMBOL[instrument];
  if (!symbol) return [];
  const raw = await fetchYahooFeed(symbol);
  return raw.slice(0, maxItems).map((r) => ({
    title: r.title,
    summary: r.description,
    url: r.link,
    publishedAt: toIsoDate(r.pubDate),
  }));
}

// Exposed for tests — allows resetting cache between cases.
export function _clearYahooCache(): void {
  cache.clear();
}
