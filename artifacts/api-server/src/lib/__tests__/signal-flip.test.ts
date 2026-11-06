import { describe, it, expect } from "vitest";
import { compareSignals } from "../signal-flip";

describe("compareSignals", () => {
  it("BUY → BUY does not flip even if confidence jumps", () => {
    const v = compareSignals(
      { action: "buy", confidence: 50 },
      { action: "buy", confidence: 90 },
    );
    expect(v.flipped).toBe(false);
  });

  it("BUY → SELL with large confidence delta flips (buy_sell_swap)", () => {
    const v = compareSignals(
      { action: "buy", confidence: 70 },
      { action: "sell", confidence: 40 },
    );
    expect(v.flipped).toBe(true);
    expect(v.reason).toBe("buy_sell_swap");
  });

  it("BUY → SELL with tiny confidence delta does not flip", () => {
    const v = compareSignals(
      { action: "buy", confidence: 50 },
      { action: "sell", confidence: 55 },
    );
    expect(v.flipped).toBe(false);
  });

  it("BUY → WAIT with confidence drop > 20 flips (to_wait)", () => {
    const v = compareSignals(
      { action: "buy", confidence: 70 },
      { action: "wait", confidence: 45 },
    );
    expect(v.flipped).toBe(true);
    expect(v.reason).toBe("to_wait");
  });

  it("WAIT → BUY with confidence jump > 20 flips (from_wait)", () => {
    const v = compareSignals(
      { action: "wait", confidence: 40 },
      { action: "buy", confidence: 75 },
    );
    expect(v.flipped).toBe(true);
    expect(v.reason).toBe("from_wait");
  });

  it("exactly-at-threshold (=20) does not flip — strict > only", () => {
    const v = compareSignals(
      { action: "buy", confidence: 50 },
      { action: "sell", confidence: 70 },
    );
    expect(v.flipped).toBe(false);
    expect(v.confidenceDiff).toBe(20);
  });
});
