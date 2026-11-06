// Admission list for NEW analyses only. Do not use this to filter historical rows.
// These spot FX pairs have both Yahoo intraday candles and daily feed coverage.
export const PRIMARY_ANALYSIS_INSTRUMENTS = new Set(["XAU/USD", "BRENT", "HSI", "NIKKEI"]);
export const VERIFIED_OTHER_INSTRUMENTS = new Set(["EUR/USD", "GBP/USD", "AUD/USD", "USD/JPY"]);
export const VERIFIED_ANALYSIS_INSTRUMENTS = new Set([
  ...PRIMARY_ANALYSIS_INSTRUMENTS,
  ...VERIFIED_OTHER_INSTRUMENTS,
]);