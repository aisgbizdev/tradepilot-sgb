import { BROKER_CONTRACT_TIERS } from "@workspace/instrument-taxonomy";

export type StandardTradingRuleInstrument = {
  code: "XUL10" | "BCO10_BBJ" | "HKK50_BBJ" | "JPK50_BBJ";
  product: string;
  contractSize: number;
  contractUnit: "troy ounce" | "barrel" | "USD/point";
  tradingDays: string;
  tradingHours: { summer: string; winter: string };
  /** Initial/day-trade margin per Mini lot. Adaptive Position Plan never uses rollover as margin. */
  initialMarginUsdPerLot: number;
  facilityFeeUsdPerLotPerSide: number | null;
  vatPercent: number;
  rolloverUsdPerLotPerNight: number;
  priceSource: string;
  priceGuidance: string;
  minimumSpread: string;
  maximumSpread: string;
  hecticSpread: string;
  minimumPriceMovement: string;
  limitStopRange: string;
  deliveryBy: string;
};

export type LocalizedTradingRuleText = {
  id: string;
  en: string;
};

export type StandardTradingRules = {
  name: "TP Standard Trading Rules";
  version: string;
  effectiveDate: string;
  sourceDocument: string;
  fixedRate: { usd: number; idr: number; label: string };
  account: {
    minimumDepositUsd: number;
    minimumLot: number;
    maximumLot: number;
    maintenanceMarginPercent: number;
    marginCallBelowPercent: number;
    marginCallRestorePercent: number;
    autoLiquidationAtOrBelowPercent: number;
    equityReviewThresholdUsd: number;
    equityReviewThresholdIdr: number;
  };
  transactionFormula: string;
  instruments: StandardTradingRuleInstrument[];
  disclaimer: LocalizedTradingRuleText;
  relationshipDisclosure: LocalizedTradingRuleText;
};

/** Single broker-neutral ruleset used by TradePilot's standard TP estimates. */
export const STANDARD_TRADING_RULES: StandardTradingRules = {
  name: "TP Standard Trading Rules",
  version: "2026.02",
  effectiveDate: "2026-02-01",
  sourceDocument: "Solid Gold / Royal Assetindo Mini Account Trading Rules (Feb 2026); Royal Assetindo CDD Mini Index Trading Rules",
  fixedRate: { usd: 1, idr: 10_000, label: "USD 1 = IDR 10.000" },
  account: {
    minimumDepositUsd: 500,
    minimumLot: 0.1,
    maximumLot: 0.9,
    maintenanceMarginPercent: 70,
    marginCallBelowPercent: 70,
    marginCallRestorePercent: 100,
    autoLiquidationAtOrBelowPercent: 30,
    equityReviewThresholdUsd: 2_500,
    equityReviewThresholdIdr: 25_000_000,
  },
  transactionFormula:
    "P/L = [(Selling Price - Buying Price) × Contract Size × n lot] - [(Facility Fee + VAT) × n lot]",
  instruments: [
    {
      code: "XUL10",
      product: "Gold (Loco London)",
      contractSize: BROKER_CONTRACT_TIERS.XUL10.mini.size,
      contractUnit: BROKER_CONTRACT_TIERS.XUL10.unit,
      tradingDays: "Monday–Friday",
      tradingHours: { summer: "06:00–03:30 WIB", winter: "06:00–04:30 WIB" },
      initialMarginUsdPerLot: 100,
      facilityFeeUsdPerLotPerSide: 1.5,
      vatPercent: 11,
      rolloverUsdPerLotPerNight: 0.5,
      priceSource: "Telequote",
      priceGuidance: "Last Trade",
      minimumSpread: "USD 0.40 / troy ounce / side",
      maximumSpread: "USD 1.00 / troy ounce / side",
      hecticSpread: "Based on market conditions",
      minimumPriceMovement: "USD 0.01 / troy ounce",
      limitStopRange: "USD 6–USD 20",
      deliveryBy: "Cash settlement",
    },
    {
      code: "BCO10_BBJ",
      product: "Brent Crude Oil",
      contractSize: BROKER_CONTRACT_TIERS.BCO10_BBJ.mini.size,
      contractUnit: BROKER_CONTRACT_TIERS.BCO10_BBJ.unit,
      tradingDays: "Monday–Friday",
      tradingHours: { summer: "07:00–03:45 WIB", winter: "08:00–03:45 WIB" },
      initialMarginUsdPerLot: 100,
      facilityFeeUsdPerLotPerSide: 1.5,
      vatPercent: 11,
      rolloverUsdPerLotPerNight: 0.5,
      priceSource: "Telequote",
      priceGuidance: "Last Trade",
      minimumSpread: "USD 0.10 / pip / barrel / side",
      maximumSpread: "USD 0.30 / pip / barrel / side",
      hecticSpread: "Based on market conditions",
      minimumPriceMovement: "USD 0.01 / barrel",
      limitStopRange: "USD 1–USD 20",
      deliveryBy: "Cash settlement",
    },
    {
      code: "HKK50_BBJ",
      product: "Hang Seng Index",
      contractSize: BROKER_CONTRACT_TIERS.HKK50_BBJ.mini.size,
      contractUnit: BROKER_CONTRACT_TIERS.HKK50_BBJ.unit,
      tradingDays: "Monday–Friday",
      tradingHours: {
        summer: "08:15–11:00, 12:00–15:30, 16:00–02:00 WIB",
        winter: "08:15–11:00, 12:00–15:30, 16:00–02:00 WIB",
      },
      initialMarginUsdPerLot: 100,
      facilityFeeUsdPerLotPerSide: null,
      vatPercent: 11,
      rolloverUsdPerLotPerNight: 0.3,
      priceSource: "Telequote",
      priceGuidance: "Last Trade",
      minimumSpread: "5 points / side",
      maximumSpread: "25 points / side",
      hecticSpread: "Based on market conditions",
      minimumPriceMovement: "1 point",
      limitStopRange: "20–500 points",
      deliveryBy: "Cash settlement",
    },
    {
      code: "JPK50_BBJ",
      product: "Nikkei Index",
      contractSize: BROKER_CONTRACT_TIERS.JPK50_BBJ.mini.size,
      contractUnit: BROKER_CONTRACT_TIERS.JPK50_BBJ.unit,
      tradingDays: "Monday–Friday",
      tradingHours: {
        summer: "06:30–13:55, 14:10–03:45 WIB",
        winter: "06:30–13:55, 14:10–03:45 WIB",
      },
      initialMarginUsdPerLot: 100,
      facilityFeeUsdPerLotPerSide: null,
      vatPercent: 11,
      rolloverUsdPerLotPerNight: 0.2,
      priceSource: "Telequote",
      priceGuidance: "Last Trade",
      minimumSpread: "10 points / side",
      maximumSpread: "25 points / side",
      hecticSpread: "Based on market conditions",
      minimumPriceMovement: "5 points",
      limitStopRange: "20–500 points",
      deliveryBy: "Cash settlement",
    },
  ],
  disclaimer: {
    id: "Estimasi biaya dan level yang memakai aturan ini berlaku untuk TP Standard Trading Rules. Ketentuan, spread, biaya, jam, dan likuidasi dapat berbeda dari broker atau penyedia layanan lain.",
    en: "Cost and level estimates using these rules apply to TP Standard Trading Rules. Terms, spreads, fees, sessions, and liquidation may differ at other brokers or service providers.",
  },
  relationshipDisclosure: {
    id: "Dokumen sumber menjelaskan kerja sama PT Solid Gold Berjangka sebagai pialang peserta SPA dan PT Royal Assetindo sebagai penyelenggara SPA. Hubungan ini ditampilkan sebagai konteks sumber, bukan pilihan broker atau rekomendasi.",
    en: "The source document describes PT Solid Gold Berjangka as the SPA participating broker and PT Royal Assetindo as the SPA organizer. This relationship is disclosed as source context, not as a broker choice or recommendation.",
  },
};