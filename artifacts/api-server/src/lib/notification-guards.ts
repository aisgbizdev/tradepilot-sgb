// Shared anti-annoyance helpers for push notifications (task #140).
// Every new push category Tier 1/2/3 introduces must go through these
// guards so we never spam users — quiet hours, per-category frequency
// caps, batching of near-duplicate items, and cross-run dedupe.

import { db } from "./db";
import { notifications } from "@workspace/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

const DEFAULT_TIMEZONE = "Asia/Jakarta";
const DEFAULT_QUIET_START_HOUR = 22; // 22:00 inclusive
const DEFAULT_QUIET_END_HOUR = 7; // 07:00 exclusive

export interface QuietHoursUser {
  /** IANA timezone the quiet-hours window is interpreted in (legacy fallback). */
  dailySummaryTimezone?: string | null;
  /** Store-readiness (P2-B4.1): per-user quiet-hours override. `false` disables
   * quiet hours entirely for this user; omitted/`true`/`null` keeps them on. */
  quietHoursEnabled?: boolean | null;
  /** "HH:MM" 24h local time. Falls back to the function's default when unset/invalid. */
  quietHoursStart?: string | null;
  /** "HH:MM" 24h local time. Falls back to the function's default when unset/invalid. */
  quietHoursEnd?: string | null;
  /** Preferred over `dailySummaryTimezone` when both are present. */
  notificationTimezone?: string | null;
}

/** Parse "HH:MM" into an hour-of-day integer (0-23); minutes are ignored to
 * keep this function's hour-bucket comparison model. Returns `fallback` for
 * anything that isn't a well-formed, in-range HH:MM string. */
function parseQuietHour(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : fallback;
}

/**
 * Return the hour-of-day (0-23) at `now` in the given IANA timezone.
 * Uses Intl.DateTimeFormat so we don't pull in a tz library.
 */
export function hourInTimezone(now: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    // `formatToParts` returns "0".."23" for the hour part. Some
    // locales render midnight as "24" — clamp defensively.
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const hour = hourPart ? parseInt(hourPart.value, 10) : Number.NaN;
    if (!Number.isFinite(hour)) return now.getUTCHours();
    return hour === 24 ? 0 : hour;
  } catch {
    // Invalid timezone string — fall back to UTC so we still produce a
    // deterministic answer instead of throwing inside a job tick.
    return now.getUTCHours();
  }
}

/**
 * Quiet hours: suppress non-urgent push between 22:00–07:00 in the
 * user's local timezone. Falls back to Asia/Jakarta when the user has
 * no timezone preference set.
 *
 * The window wraps midnight, so any hour h satisfies
 *   h >= start || h < end
 * e.g. 22, 23, 0, 1, ..., 6 are all "quiet".
 */
export function withinQuietHours(
  user: QuietHoursUser,
  now: Date = new Date(),
  opts: { startHour?: number; endHour?: number } = {},
): boolean {
  if (user.quietHoursEnabled === false) return false;
  const start = opts.startHour ?? parseQuietHour(user.quietHoursStart, DEFAULT_QUIET_START_HOUR);
  const end = opts.endHour ?? parseQuietHour(user.quietHoursEnd, DEFAULT_QUIET_END_HOUR);
  const tz = user.notificationTimezone || user.dailySummaryTimezone || DEFAULT_TIMEZONE;
  const hour = hourInTimezone(now, tz);
  if (start === end) return false;
  if (start < end) {
    // Same-day window e.g. 13–17.
    return hour >= start && hour < end;
  }
  // Wraps midnight (the default case).
  return hour >= start || hour < end;
}

/**
 * Count how many notifications in `category` have been delivered to
 * the user inside the trailing `windowMs`, and return whether sending
 * one more would still fit under `maxCount`.
 *
 * Returns `{ allowed: false, sentInWindow }` when the cap is already
 * met or exceeded, so callers can both decide AND log the suppression.
 */
export async function respectFrequencyCap(
  userId: number,
  category: string,
  windowMs: number,
  maxCount: number,
): Promise<{ allowed: boolean; sentInWindow: number }> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.category, category),
        gte(notifications.createdAt, since),
      ),
    );
  const sentInWindow = row?.c ?? 0;
  return { allowed: sentInWindow < maxCount, sentInWindow };
}

/**
 * Has a notification row with this exact `dedupeKey` already been
 * inserted? Postgres enforces uniqueness on the column, so this is
 * mostly a fast-path to skip work — the unique index is the hard
 * backstop against a race between concurrent job ticks.
 */
export async function alreadyDelivered(dedupeKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey))
    .limit(1);
  return Boolean(row);
}

export interface BatchableItem {
  /** Bucket key — items sharing this key are grouped together. */
  key: string;
  /** Wall-clock time the item was emitted by the upstream source. */
  timestamp: number;
}

export interface BatchedGroup<T extends BatchableItem> {
  key: string;
  items: T[];
}

/**
 * Collapse items into per-key buckets when ≥2 items in the same bucket
 * land inside a `windowMs` rolling window. Each input item still
 * appears in exactly one output group; singletons come back as 1-item
 * groups so the caller can render "1 news" vs "3 news" uniformly.
 *
 * Order inside each group preserves the input order so the
 * highest-priority item (callers should sort before passing in) ends
 * up first in the rendered batch.
 */
export function batchSimilar<T extends BatchableItem>(
  items: T[],
  windowMs: number,
): BatchedGroup<T>[] {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(item.key) ?? [];
    bucket.push(item);
    grouped.set(item.key, bucket);
  }
  const out: BatchedGroup<T>[] = [];
  for (const [key, bucket] of grouped) {
    if (bucket.length <= 1) {
      out.push({ key, items: bucket });
      continue;
    }
    // Sort by timestamp ascending so we can detect tight clusters.
    const sorted = [...bucket].sort((a, b) => a.timestamp - b.timestamp);
    const minTs = sorted[0]!.timestamp;
    const maxTs = sorted[sorted.length - 1]!.timestamp;
    if (maxTs - minTs <= windowMs) {
      // All items in the bucket fit inside the window — collapse.
      out.push({ key, items: bucket });
    } else {
      // Spread out — emit each as its own group so we don't pretend
      // an hours-old item is "fresh news" alongside a brand-new one.
      for (const item of bucket) out.push({ key, items: [item] });
    }
  }
  return out;
}
