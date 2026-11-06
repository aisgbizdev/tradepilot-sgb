import { describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";

describe("GET /trading-rules/standard", () => {
  it("publishes one broker-neutral TP ruleset with the source parameters", async () => {
    const response = await request(app).get("/api/trading-rules/standard");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: "TP Standard Trading Rules",
      version: "2026.02",
      effectiveDate: "2026-02-01",
      fixedRate: { usd: 1, idr: 10_000 },
      account: {
        minimumDepositUsd: 500,
        minimumLot: 0.1,
        maximumLot: 0.9,
        maintenanceMarginPercent: 70,
        marginCallBelowPercent: 70,
        autoLiquidationAtOrBelowPercent: 30,
      },
    });
    expect(response.body).not.toHaveProperty("broker");
    expect(response.body.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "XUL10", contractSize: 10, minimumPriceMovement: "USD 0.01 / troy ounce" }),
        expect.objectContaining({ code: "BCO10_BBJ", contractSize: 100, minimumPriceMovement: "USD 0.01 / barrel" }),
        expect.objectContaining({
          code: "HKK50_BBJ",
          contractSize: 5,
          contractUnit: "USD/point",
          initialMarginUsdPerLot: 100,
          facilityFeeUsdPerLotPerSide: null,
          rolloverUsdPerLotPerNight: 0.3,
          minimumPriceMovement: "1 point",
        }),
        expect.objectContaining({
          code: "JPK50_BBJ",
          contractSize: 5,
          contractUnit: "USD/point",
          initialMarginUsdPerLot: 100,
          facilityFeeUsdPerLotPerSide: null,
          rolloverUsdPerLotPerNight: 0.2,
          minimumPriceMovement: "5 points",
        }),
      ]),
    );
    expect(response.body.disclaimer.id).toContain("TP Standard Trading Rules");
    expect(response.body.disclaimer.en).toContain("other brokers");
    expect(response.body.relationshipDisclosure.id).toContain("PT Solid Gold Berjangka");
    expect(response.body.relationshipDisclosure.en).toContain("PT Royal Assetindo");
  });
});