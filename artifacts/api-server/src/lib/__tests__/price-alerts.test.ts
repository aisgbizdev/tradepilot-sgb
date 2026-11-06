import { describe, expect, it } from "vitest";
import {
  deriveDirection,
  shouldCancelSiblingsAfter,
  shouldFireAlert,
} from "../price-alerts";

describe("price-alerts pure helpers", () => {
  describe("deriveDirection", () => {
    it("returns 'below' when spot is above the level (price must fall to fire)", () => {
      expect(deriveDirection(2400, 2350)).toBe("below");
    });

    it("returns 'above' when spot is below the level (price must rise to fire)", () => {
      expect(deriveDirection(2300, 2350)).toBe("above");
    });

    it("returns 'above' when spot equals the level so the next upward tick fires", () => {
      expect(deriveDirection(2350, 2350)).toBe("above");
    });
  });

  describe("shouldFireAlert", () => {
    it("fires when armed 'above' and live crosses up through the level", () => {
      expect(shouldFireAlert(2351, 2350, "above")).toBe(true);
    });

    it("fires when armed 'above' and live exactly touches the level", () => {
      expect(shouldFireAlert(2350, 2350, "above")).toBe(true);
    });

    it("does NOT fire when armed 'above' but live is still below", () => {
      expect(shouldFireAlert(2349.99, 2350, "above")).toBe(false);
    });

    it("fires when armed 'below' and live crosses down through the level", () => {
      expect(shouldFireAlert(2349, 2350, "below")).toBe(true);
    });

    it("does NOT fire when armed 'below' but live is still above", () => {
      expect(shouldFireAlert(2350.01, 2350, "below")).toBe(false);
    });

    it("never fires when livePrice is non-finite (NaN / Infinity)", () => {
      expect(shouldFireAlert(Number.NaN, 2350, "above")).toBe(false);
      expect(shouldFireAlert(Number.POSITIVE_INFINITY, 2350, "above")).toBe(false);
    });

    it("never fires when levelPrice is non-finite", () => {
      expect(shouldFireAlert(2350, Number.NaN, "above")).toBe(false);
    });
  });

  describe("shouldCancelSiblingsAfter", () => {
    it("does NOT cancel siblings when entry fires — the trade is just starting", () => {
      expect(shouldCancelSiblingsAfter("entry")).toBe(false);
    });

    it("cancels siblings when SL fires — the trade is resolved as a loss", () => {
      expect(shouldCancelSiblingsAfter("sl")).toBe(true);
    });

    it("cancels siblings when TP1 fires — at least the first target is in", () => {
      expect(shouldCancelSiblingsAfter("tp1")).toBe(true);
    });

    it("cancels siblings when TP2 fires — the full plan has resolved", () => {
      expect(shouldCancelSiblingsAfter("tp2")).toBe(true);
    });
  });
});
