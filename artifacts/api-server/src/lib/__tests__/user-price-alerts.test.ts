import { describe, expect, it } from "vitest";
import { shouldFireCrossing } from "../user-price-alerts";
import { KNOWN_INSTRUMENTS } from "../../routes/user-price-alerts";
import { CRYPTO_INSTRUMENTS } from "../crypto-instruments";

describe("KNOWN_INSTRUMENTS allowlist", () => {
  it("accepts every supported crypto pair so price alerts can be created on them", () => {
    for (const pair of CRYPTO_INSTRUMENTS) {
      expect(KNOWN_INSTRUMENTS.has(pair)).toBe(true);
    }
  });

  it("still keeps the core forex / commodity coverage", () => {
    expect(KNOWN_INSTRUMENTS.has("XAU/USD")).toBe(true);
    expect(KNOWN_INSTRUMENTS.has("EUR/USD")).toBe(true);
    expect(KNOWN_INSTRUMENTS.has("USD/IDR")).toBe(true);
  });

  it("rejects an obviously bogus instrument string", () => {
    expect(KNOWN_INSTRUMENTS.has("FOO/BAR")).toBe(false);
  });
});

describe("shouldFireCrossing", () => {
  describe("direction = above", () => {
    it("fires when previous tick was below target and current crosses up", () => {
      expect(shouldFireCrossing(1.085, 1.091, 1.09, "above")).toBe(true);
    });
    it("fires when current exactly reaches target from below", () => {
      expect(shouldFireCrossing(1.085, 1.09, 1.09, "above")).toBe(true);
    });
    it("does NOT fire if price is already above target on the first observation", () => {
      expect(shouldFireCrossing(null, 1.10, 1.09, "above")).toBe(false);
    });
    it("does NOT fire when both ticks remain above target", () => {
      expect(shouldFireCrossing(1.10, 1.11, 1.09, "above")).toBe(false);
    });
    it("does NOT fire when both ticks remain below target", () => {
      expect(shouldFireCrossing(1.08, 1.085, 1.09, "above")).toBe(false);
    });
  });

  describe("direction = below", () => {
    it("fires when previous tick was above target and current crosses down", () => {
      expect(shouldFireCrossing(1.095, 1.089, 1.09, "below")).toBe(true);
    });
    it("fires when current exactly reaches target from above", () => {
      expect(shouldFireCrossing(1.095, 1.09, 1.09, "below")).toBe(true);
    });
    it("does NOT fire if price is already below target on the first observation", () => {
      expect(shouldFireCrossing(null, 1.08, 1.09, "below")).toBe(false);
    });
    it("does NOT fire when both ticks remain below target", () => {
      expect(shouldFireCrossing(1.08, 1.085, 1.09, "below")).toBe(false);
    });
  });

  describe("guards", () => {
    it("does NOT fire on non-finite inputs", () => {
      expect(shouldFireCrossing(NaN, 1.09, 1.09, "above")).toBe(false);
      expect(shouldFireCrossing(1.08, Infinity, 1.09, "above")).toBe(false);
      expect(shouldFireCrossing(1.08, 1.09, NaN, "below")).toBe(false);
    });
  });
});
