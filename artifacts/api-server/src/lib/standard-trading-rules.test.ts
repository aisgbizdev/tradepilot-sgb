import { describe, expect, it } from "vitest";
import { BROKER_CONTRACT_TIERS } from "@workspace/instrument-taxonomy";
import { STANDARD_TRADING_RULES } from "./standard-trading-rules";

describe("Standard Mini broker contract synchronization", () => {
  it("keeps the documented tier table and Micro assumptions explicit", () => {
    expect(BROKER_CONTRACT_TIERS).toMatchObject({
      XUL10: { unit: "troy ounce", mini: { size: 10 }, regular: { size: 100 }, micro: { size: 1 } },
      BCO10_BBJ: { unit: "barrel", mini: { size: 100 }, regular: { size: 1_000 }, micro: { size: 10 } },
      HKK50_BBJ: { unit: "USD/point", mini: { size: 5 }, regular: { size: 5 }, micro: { size: 0.5 } },
      JPK50_BBJ: { unit: "USD/point", mini: { size: 5 }, regular: { size: 5 }, micro: { size: 0.5 } },
    });
    for (const contract of Object.values(BROKER_CONTRACT_TIERS)) {
      expect(contract.mini.source).toBe("broker_document");
      expect(contract.regular.source).toBe("broker_document");
      expect(contract.micro.source).toBe("micro_assumption");
      expect(contract.micro.size).toBe(contract.mini.size / 10);
    }
  });

  it("exports only Mini contract sizes and units in the unchanged Standard API shape", () => {
    expect(STANDARD_TRADING_RULES.instruments).toHaveLength(Object.keys(BROKER_CONTRACT_TIERS).length);
    for (const instrument of STANDARD_TRADING_RULES.instruments) {
      const contract = BROKER_CONTRACT_TIERS[instrument.code];
      expect(instrument.contractSize).toBe(contract.mini.size);
      expect(instrument.contractUnit).toBe(contract.unit);
      expect(instrument).not.toHaveProperty("regular");
      expect(instrument).not.toHaveProperty("micro");
    }
  });
});