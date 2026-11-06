import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import app from "../../app";
import { db } from "../../lib/db";
import { instrumentRequests, sessions, users } from "@workspace/db/schema";

const suffix = randomBytes(4).toString("hex");
const code = `TEST${suffix.toUpperCase()}`;
const people: { id: number; token: string }[] = [];

beforeAll(async () => {
  for (const role of ["user", "user", "admin"] as const) {
    const [person] = await db.insert(users).values({
      email: `requests-${role}-${randomBytes(6).toString("hex")}@example.test`,
      displayName: "Request test",
      role,
    }).returning({ id: users.id });
    const token = `request-test-${randomBytes(20).toString("hex")}`;
    await db.insert(sessions).values({ userId: person.id, token, expiresAt: new Date(Date.now() + 3600000) });
    people.push({ id: person.id, token });
  }
});

afterAll(async () => {
  if (!people.length) return;
  const ids = people.map((person) => person.id);
  await db.delete(instrumentRequests).where(inArray(instrumentRequests.userId, ids));
  await db.delete(sessions).where(inArray(sessions.userId, ids));
  await db.delete(users).where(inArray(users.id, ids));
});

const signed = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("verified instrument admission and code interest", () => {
  it("rejects unsupported analysis and invalid timeframe before consuming credits", async () => {
    const rejected = await request(app).post("/api/analyses").set(signed(people[0].token))
      .send({ instrument: code, timeframe: "1h", mode: "pro" });
    expect(rejected.status).toBe(400);
    const invalidTimeframe = await request(app).post("/api/analyses").set(signed(people[0].token))
      .send({ instrument: "EUR/USD", timeframe: "2W", mode: "pro" });
    expect(invalidTimeframe.status).toBe(400);
  });

  it("deduplicates repeat requests, ranks unique users, and restricts the admin list", async () => {
    expect((await request(app).post("/api/instrument-requests").set(signed(people[0].token))
      .send({ code: "EUR/USD" })).status).toBe(400);
    expect((await request(app).post("/api/instrument-requests").set(signed(people[0].token))
      .send({ code: "<script>" })).status).toBe(400);
    for (const person of [people[0], people[0], people[1]]) {
      const result = await request(app).post("/api/instrument-requests").set(signed(person.token))
        .send({ code: code.toLowerCase() });
      expect(result.status).toBe(201);
      expect(result.body.code).toBe(code);
    }
    expect((await request(app).get("/api/admin/instrument-requests")
      .set(signed(people[0].token))).status).toBe(403);
    const ranked = await request(app).get("/api/admin/instrument-requests")
      .set(signed(people[2].token));
    expect(ranked.status).toBe(200);
    expect(ranked.body.requests.find((item: { code: string }) => item.code === code))
      .toMatchObject({ code, interestedUsers: 2 });
    expect((await db.select().from(instrumentRequests).where(eq(instrumentRequests.code, code))).length).toBe(2);
  });
});