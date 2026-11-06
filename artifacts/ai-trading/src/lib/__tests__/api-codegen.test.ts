import { describe, expect, it } from "vitest";
import { getGetAnalysisHistorySummaryUrl } from "@workspace/api-client-react";

describe("generated analysis history URL", () => {
  it("serializes multi-value filters as repeated query parameters", () => {
    const url = getGetAnalysisHistorySummaryUrl({
      range: "30",
      instruments: ["XAU/USD", "BTC/USD"],
      timeframes: ["1h", "4h"],
    });
    const params = new URL(url, "https://example.test").searchParams;

    expect(params.getAll("instruments")).toEqual(["XAU/USD", "BTC/USD"]);
    expect(params.getAll("timeframes")).toEqual(["1h", "4h"]);
  });
});