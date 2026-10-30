import { describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("./routes", async () => {
  const { default: express } = await import("express");
  return { default: express.Router() };
});

vi.mock("./routes/trade-pilot", async () => {
  const { default: express } = await import("express");
  return { default: express.Router() };
});

import app from "./app";

const PREVIEW_ORIGIN = "https://preview.example.test";
const API_ORIGIN = "https://api.example.test";

describe("API-scoped CORS", () => {
  it("does not intercept non-API asset requests", async () => {
    const response = await request(app)
      .get("/assets/app.css")
      .set("Origin", PREVIEW_ORIGIN);

    // The test environment has no production static directory, so reaching
    // Express's normal 404 proves the request passed the API-only CORS layer.
    expect(response.status).toBe(404);
  });

  it("allows API requests whose origin matches the forwarded request host", async () => {
    const response = await request(app)
      .options("/api/auth/me")
      .set("Host", "preview.example.test")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", PREVIEW_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      PREVIEW_ORIGIN,
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("still rejects unconfigured origins for API requests", async () => {
    const response = await request(app)
      .options("/api/auth/me")
      .set("Host", "api.example.test")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", PREVIEW_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(500);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still rejects unconfigured origins for Trade Pilot API requests", async () => {
    const response = await request(app)
      .options("/v1/trade-pilot/bootstrap")
      .set("Host", "preview.example.test")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", API_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(response.status).toBe(500);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
