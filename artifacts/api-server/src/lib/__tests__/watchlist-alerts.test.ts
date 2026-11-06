import { describe, it, expect } from "vitest";
import {
  isHighImpactNews,
  calendarReminderTimestamp,
} from "../watchlist-alerts";
import type { NewsItem } from "../news";
import type { CalendarEvent } from "../calendar";

function makeNews(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "n1",
    title: "Generic headline",
    summary: "",
    source: "Yahoo Finance",
    url: null,
    publishedAt: new Date().toISOString(),
    ...over,
  };
}

function makeEvent(over: Partial<CalendarEvent> = {}): CalendarEvent {
  const date = over.date ?? "2026-05-27";
  const time = "time" in over ? over.time : "20:00";
  const [y, mon, d] = date.split("-").map(Number);
  const [h, min] = (time ?? "00:00").split(":").map(Number);
  const epochMs =
    "epochMs" in over
      ? over.epochMs ?? null
      : Date.UTC(y!, mon! - 1, d!, h!, min!, 0, 0);
  return {
    date,
    time: time ?? null,
    epochMs,
    currency: "USD",
    event: "FOMC Meeting Minutes",
    impact: "★★★",
    actual: null,
    forecast: null,
    previous: null,
    ...over,
  };
}

describe("isHighImpactNews", () => {
  it("returns true for FOMC headline", () => {
    expect(isHighImpactNews(makeNews({ title: "FOMC holds rates" }))).toBe(true);
  });

  it("returns true for CPI headline", () => {
    expect(isHighImpactNews(makeNews({ title: "US CPI prints hotter than expected" }))).toBe(true);
  });

  it("returns true for war / sanctions in summary", () => {
    expect(
      isHighImpactNews(
        makeNews({ title: "Oil traders weigh fresh headlines", summary: "New sanctions announced" }),
      ),
    ).toBe(true);
  });

  it("returns false for unrelated headlines", () => {
    expect(isHighImpactNews(makeNews({ title: "Local restaurant opens new branch" }))).toBe(false);
  });
});

describe("calendarReminderTimestamp", () => {
  it("matches inside the 25–35 min window", () => {
    const now = new Date("2026-05-27T12:30:00.000Z");
    const ts = calendarReminderTimestamp(
      makeEvent({ date: "2026-05-27", time: "13:00", impact: "★★★" }),
      now,
    );
    expect(ts).toBe(Date.parse("2026-05-27T13:00:00"));
  });

  it("rejects events less than 25 min out", () => {
    const now = new Date("2026-05-27T12:40:00.000Z");
    const ts = calendarReminderTimestamp(
      makeEvent({ date: "2026-05-27", time: "13:00", impact: "★★★" }),
      now,
    );
    expect(ts).toBeNull();
  });

  it("rejects events more than 35 min out", () => {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const ts = calendarReminderTimestamp(
      makeEvent({ date: "2026-05-27", time: "13:00", impact: "★★★" }),
      now,
    );
    expect(ts).toBeNull();
  });

  it("rejects low-impact events even inside the window", () => {
    const now = new Date("2026-05-27T12:30:00.000Z");
    const ts = calendarReminderTimestamp(
      makeEvent({ date: "2026-05-27", time: "13:00", impact: "★★" }),
      now,
    );
    expect(ts).toBeNull();
  });

  it("rejects events with no time", () => {
    const now = new Date("2026-05-27T12:30:00.000Z");
    const ts = calendarReminderTimestamp(
      makeEvent({ date: "2026-05-27", time: null, impact: "★★★" }),
      now,
    );
    expect(ts).toBeNull();
  });
});
