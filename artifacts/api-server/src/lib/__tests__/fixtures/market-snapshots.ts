import type { IndicatorTimeframe } from "../../historical";
import type { MarketSnapshot } from "../../market-evaluation";

// Frozen on 2026-09-25 UTC from Yahoo chart OHLC (intraday futures/spot)
// and the project's historical daily feed. Each range and change is computed
// from the last 20 source bars (100 daily bars for 1W); 4h uses 20
// UTC-aligned buckets resampled from hourly OHLC.
// Futures quotes can differ from the daily index/spot feed. Never mix anchors.
type Row = [number, number, number, number];
const intraday: Record<string, { symbol: string; at: string; rows: Row[] }> = {
  "XAU/USD": { symbol: "GC=F", at: "2026-09-25T03:11:11Z", rows: [
    [4319.3999,4313.6001,4321.6001,0.11], [4319.2998,4313,4331,-0.2],
    [4319.2998,4299.2998,4331,0.31], [4319.2998,4291.2998,4331,0.48],
    [4319.2998,4278.2998,4331,0.55], [4318.5,4278.2998,4414.1001,-2],
  ] },
  BRENT: { symbol: "BZ=F", at: "2026-09-25T03:11:07Z", rows: [
    [105.39,105.38,105.82,-0.4], [105.39,105.38,106.01,-0.29],
    [105.39,105.38,106.75,-1.21], [105.39,105.15,107.7,-0.99],
    [105.39,99,108.23,4.71], [105.36,95.04,108.23,9.46],
  ] },
  HSI: { symbol: "^HSI", at: "2026-09-25T03:06:16Z", rows: [
    [24324.9395,24275.5605,24327.7207,0.11], [24324.9395,24275.5605,24405.0293,-0.22],
    [24324.9395,24275.5605,24782.3809,-1.54], [24324.9395,24275.5605,24834.1191,-2.03],
    [24324.9395,24275.5605,25149.7598,-2.94], [24330.0996,24275.5605,25254.1094,-1.92],
  ] },
  NIKKEI: { symbol: "NIY=F", at: "2026-09-25T03:11:13Z", rows: [
    [66105,66035,66125,0.03], [66105,66035,66185,-0.08],
    [66105,65315,66185,0.9], [66105,65315,66185,0.66],
    [66105,65095,66185,1.38], [66115,65095,67145,-0.69],
  ] },
};
const daily: Record<string, { symbol: string; rows: Row[] }> = {
  "XAU/USD": { symbol: "LGD Daily", rows: [[4265.28,4234.92,4631.17,-4.32],[4265.28,3944.5,4773.35,-9.58]] },
  BRENT: { symbol: "BCO Daily", rows: [[107.24,87.26,109.77,21.55],[107.24,70.15,112.71,6.88]] },
  HSI: { symbol: "HSI Daily", rows: [[24627,24333,25774,-3.32],[24627,22522,26860,-4.77]] },
  NIKKEI: { symbol: "SNI Daily", rows: [[65440,62535,67140,-0.62],[65440,59350,73760,2.8]] },
};
const intraFrames: IndicatorTimeframe[] = ["1m","5m","15m","30m","1h","4h"];
export const marketSnapshots: MarketSnapshot[] = Object.entries(intraday).flatMap(([instrument, sample]) => [
  ...sample.rows.map(([quote,low,high,changePct], index): MarketSnapshot => ({
    instrument, timeframe: intraFrames[index]!,
    source: `Yahoo chart ${sample.symbol} ${index === 5 ? "60m resampled to 4h UTC" : intraFrames[index] === "1h" ? "60m" : intraFrames[index]}`,
    observedAt: index === 0 && instrument === "XAU/USD" ? "2026-09-25T03:10:52Z" : index === 5 ? ({
      "XAU/USD": "2026-09-25T03:13:14Z", BRENT: "2026-09-25T03:12:01Z",
      HSI: "2026-09-25T03:08:14Z", NIKKEI: "2026-09-25T03:12:38Z",
    } as Record<string, string>)[instrument]! : sample.at,
    quote, low, high, changePct, bars: 20,
  })),
  ...daily[instrument]!.rows.map(([quote,low,high,changePct], index): MarketSnapshot => ({
    instrument, timeframe: index === 0 ? "1D" : "1W",
    source: `Historical ${daily[instrument]!.symbol}`, observedAt: "2026-09-24T21:16:36Z",
    quote, low, high, changePct, bars: index === 0 ? 20 : 100,
  })),
]);