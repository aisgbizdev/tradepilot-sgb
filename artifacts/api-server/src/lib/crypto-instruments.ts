// Single source of truth for the crypto instruments the app supports.
// Kept tiny on purpose — adding a new coin = add one row to each table
// below + the matching TradingView/UI mapping on the client.
//
// Why these five: BTC + ETH are unavoidable; SOL/BNB/XRP are the most-
// traded altcoins by spot volume on Indonesian retail venues. We stick
// to spot perpetual pairs against USD-stablecoin (Binance USDT) to
// match the audience and avoid futures/perp complexity in v1.

export const CRYPTO_INSTRUMENTS = [
  "BTC/USD",
  "ETH/USD",
  "SOL/USD",
  "BNB/USD",
  "XRP/USD",
] as const;

export type CryptoInstrument = (typeof CRYPTO_INSTRUMENTS)[number];

const CRYPTO_SET = new Set<string>(CRYPTO_INSTRUMENTS);

/**
 * Normalize then test. We accept `btc/usd`, `BTC/USD `, `Btc/Usd`, etc.,
 * so that user-entered free-text in the analyze input is routed through
 * the same crypto code paths (Binance live quote, Yahoo OHLC, crypto
 * prompt context) as the picker presets. Without normalization the UI
 * could show the "Crypto · 24/7" pill while the server still used
 * forex-side fallbacks — confusing and hard to spot.
 */
export function isCryptoInstrument(instrument: string): boolean {
  return CRYPTO_SET.has(instrument.trim().toUpperCase());
}

function canonicalCrypto(instrument: string): CryptoInstrument | null {
  const key = instrument.trim().toUpperCase();
  return CRYPTO_SET.has(key) ? (key as CryptoInstrument) : null;
}

// Binance spot ticker symbols (USDT-margined). We use Binance's public
// /api/v3/ticker/24hr because it is unauthenticated, high-availability,
// and returns the bid/ask/24h-change shape we need without a paid feed.
export const BINANCE_SYMBOL_MAP: Record<CryptoInstrument, string> = {
  "BTC/USD": "BTCUSDT",
  "ETH/USD": "ETHUSDT",
  "SOL/USD": "SOLUSDT",
  "BNB/USD": "BNBUSDT",
  "XRP/USD": "XRPUSDT",
};

// Yahoo Finance crypto symbols. Used for both intraday and daily/weekly
// OHLC since the upstream daily feed (forex/commodity) doesn't carry
// crypto. Yahoo exposes the same `interval=1d`/`60m`/`1m` chart shape
// for crypto as for everything else, so we reuse the existing Yahoo
// candle pipeline.
export const YAHOO_CRYPTO_SYMBOL_MAP: Record<CryptoInstrument, string> = {
  "BTC/USD": "BTC-USD",
  "ETH/USD": "ETH-USD",
  "SOL/USD": "SOL-USD",
  "BNB/USD": "BNB-USD",
  "XRP/USD": "XRP-USD",
};

export function binanceSymbolFor(instrument: string): string | null {
  const k = canonicalCrypto(instrument);
  return k ? BINANCE_SYMBOL_MAP[k] : null;
}

export function yahooCryptoSymbolFor(instrument: string): string | null {
  const k = canonicalCrypto(instrument);
  return k ? YAHOO_CRYPTO_SYMBOL_MAP[k] : null;
}
