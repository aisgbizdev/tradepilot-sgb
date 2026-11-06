import { afterEach, describe, expect, it, vi } from "vitest";

const { creditDb, updates } = vi.hoisted(() => {
  const updates: Record<string, unknown>[] = [];
  const creditDb = { insert: vi.fn(), select: vi.fn(), update: vi.fn() };
  return { creditDb, updates };
});
vi.mock("../db", () => ({ db: creditDb, pool: {} }));

import { creditPeriodWindow, creditTrialEndsAt, getTradePilotCredit } from "../trade-pilot";
import { _setTradePilotSettingsCache } from "../trade-pilot-settings";

afterEach(() => {
  _setTradePilotSettingsCache({ quota: null });
  vi.clearAllMocks();
  updates.length = 0;
});

describe("non-resetting credit balance", () => {
  it("preserves exhausted credits even when the old reset date has expired", async () => {
    _setTradePilotSettingsCache({ quota: {
      demo: { allowance: 5, period: "never" }, real: { allowance: 50, period: "monthly" },
    } });
    creditDb.insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: async () => {} }) }));
    creditDb.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [{
      createdAt: new Date("2026-01-01T00:00:00Z"), allowance: 5, consumed: 5,
      resetsAt: new Date("2026-01-02T00:00:00Z"),
    }] }) }) }));
    creditDb.update.mockImplementation(() => ({ set: (value: Record<string, unknown>) => {
      updates.push(value);
      return { where: async () => {} };
    } }));
    const result = await getTradePilotCredit("test-user", "demo");
    expect(result).toMatchObject({ allowance: 5, consumed: 5, remaining: 0, resetsAt: null });
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("consumed");
    expect(updates[0].resetsAt).toEqual(new Date("9999-12-31T00:00:00.000Z"));
  });
});

// Helper: waktu WIB -> Date.
const wib = (iso: string) => new Date(`${iso}+07:00`);

describe("creditPeriodWindow (berjangkar pada pertama kali pakai)", () => {
  it("never keeps the same window across daily, weekly and monthly boundaries", () => {
    const anchor = wib("2026-10-29T13:12:00");
    const first = creditPeriodWindow("never", anchor, anchor);
    expect(first.start).toEqual(anchor);
    expect(first.end.toISOString()).toBe("9999-12-31T00:00:00.000Z");
    expect(creditPeriodWindow("never", anchor, wib("2028-12-31T23:59:00"))).toEqual(first);
  });
  it("bulanan: reset di tanggal yang sama setiap bulan pukul 00:00 WIB", () => {
    const anchor = wib("2026-10-29T13:12:00");
    expect(creditPeriodWindow("monthly", anchor, wib("2026-10-29T13:15:00"))).toEqual({
      start: wib("2026-10-29T00:00:00"),
      end: wib("2026-11-29T00:00:00"),
    });
    expect(creditPeriodWindow("monthly", anchor, wib("2026-12-05T08:00:00"))).toEqual({
      start: wib("2026-11-29T00:00:00"),
      end: wib("2026-12-29T00:00:00"),
    });
  });

  it("bulanan: tanggal 31 jatuh ke akhir bulan pendek lalu kembali ke 31", () => {
    const anchor = wib("2026-01-31T10:00:00");
    expect(creditPeriodWindow("monthly", anchor, wib("2026-02-15T10:00:00"))).toEqual({
      start: wib("2026-01-31T00:00:00"),
      end: wib("2026-02-28T00:00:00"),
    });
    expect(creditPeriodWindow("monthly", anchor, wib("2026-03-10T10:00:00"))).toEqual({
      start: wib("2026-02-28T00:00:00"),
      end: wib("2026-03-31T00:00:00"),
    });
  });

  it("bulanan: tepat di batas reset masuk ke periode baru", () => {
    const anchor = wib("2026-10-29T13:12:00");
    expect(creditPeriodWindow("monthly", anchor, wib("2026-11-29T00:00:00")).start).toEqual(wib("2026-11-29T00:00:00"));
    expect(creditPeriodWindow("monthly", anchor, wib("2026-11-28T23:59:00")).end).toEqual(wib("2026-11-29T00:00:00"));
  });

  it("mingguan: setiap 7 hari sejak hari pertama pakai", () => {
    const anchor = wib("2026-10-29T13:12:00"); // Kamis
    expect(creditPeriodWindow("weekly", anchor, wib("2026-11-07T09:00:00"))).toEqual({
      start: wib("2026-11-05T00:00:00"),
      end: wib("2026-11-12T00:00:00"),
    });
  });

  it("harian: reset setiap 00:00 WIB", () => {
    expect(creditPeriodWindow("daily", wib("2026-10-01T10:00:00"), wib("2026-10-29T06:30:00"))).toEqual({
      start: wib("2026-10-29T00:00:00"),
      end: wib("2026-10-30T00:00:00"),
    });
  });
});

describe("demo trial window", () => {
  const mockRow = (row: Record<string, unknown>) => {
    creditDb.insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: async () => {} }) }));
    creditDb.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }));
    creditDb.update.mockImplementation(() => ({ set: () => ({ where: async () => {} }) }));
  };

  it("ends 14 days after 00:00 WIB of the first demo use; real has no limit", () => {
    // 2026-11-06 10:00 WIB -> hari pertama 2026-11-06 -> berakhir 2026-11-20 00:00 WIB.
    const start = new Date("2026-11-06T03:00:00Z");
    expect(creditTrialEndsAt("demo", start)?.toISOString()).toBe("2026-11-19T17:00:00.000Z");
    expect(creditTrialEndsAt("real", start)).toBeNull();
  });

  it("reports an expired demo balance with zero remaining and no reset", async () => {
    mockRow({
      allowance: 3, consumed: 0,
      resetsAt: new Date(Date.now() + 3_600_000),
      trialStartedAt: new Date(Date.now() - 20 * 86_400_000),
    });
    const result = await getTradePilotCredit("test-user", "demo");
    expect(result).toMatchObject({ allowance: 3, remaining: 0, expired: true });
  });

  it("keeps an active demo balance usable inside the 14-day window", async () => {
    mockRow({
      allowance: 3, consumed: 1,
      resetsAt: new Date(Date.now() + 3_600_000),
      trialStartedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const result = await getTradePilotCredit("test-user", "demo");
    expect(result).toMatchObject({ remaining: 2, expired: false });
    expect(result.trialEndsAt).not.toBeNull();
  });
});
