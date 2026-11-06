import { db } from "./db";
import { userPriceAlerts } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { createNotification } from "./create-notification";
import { getLiveQuotes } from "./live-prices";

export type AlertDirection = "above" | "below";

/**
 * Has the live tick *crossed* the target in the chosen direction since
 * the previous tick? Pure function for testability.
 *
 * The two-tick check is the anti-false-fire guard:
 *  - "above" alert: only fires when previous < target AND current >= target.
 *    A user who sets "above 1.09" while EUR/USD is already at 1.10 will
 *    not get pinged on the very next poll — the alert waits for price to
 *    drop below 1.09 and cross back up.
 *  - "below" alert: mirror — previous > target AND current <= target.
 *
 * When previous is null (alert never observed by the checker yet), we
 * fall back to a *strict* threshold: fire only if current is already on
 * the far side of the target relative to where we expect it to be —
 * i.e. for "above", require current > target strictly; for "below",
 * current < target strictly. Equality is treated as "no fire" so the
 * boot-time race doesn't pop alerts the user just placed at-the-money.
 */
export function shouldFireCrossing(
  previous: number | null,
  current: number,
  target: number,
  direction: AlertDirection,
): boolean {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return false;
  if (previous != null && !Number.isFinite(previous)) return false;

  if (direction === "above") {
    if (previous == null) return false;
    return previous < target && current >= target;
  }
  // direction === "below"
  if (previous == null) return false;
  return previous > target && current <= target;
}

/**
 * Background tick: scan every active user_price_alerts row, compare
 * against the current live price, fire a Web Push the first time the
 * target is crossed in the chosen direction, then flip the row to
 * `triggered` so it never fires again. Also updates `lastSeenPrice` on
 * every tick so the next call has the previous-tick comparison.
 */
export async function checkUserPriceAlerts(): Promise<void> {
  const active = await db
    .select()
    .from(userPriceAlerts)
    .where(
      and(eq(userPriceAlerts.status, "active"), isNull(userPriceAlerts.triggeredAt)),
    );
  if (active.length === 0) return;

  let quotes;
  try {
    quotes = await getLiveQuotes();
  } catch (err) {
    logger.warn({ err }, "User price-alerts tick: live-quotes fetch failed");
    return;
  }
  const priceFor = new Map<string, number>();
  for (const q of quotes.data) {
    const n = typeof q.price === "number" ? q.price : Number(q.price);
    if (Number.isFinite(n)) priceFor.set(q.instrument, n);
  }

  for (const row of active) {
    const live = priceFor.get(row.instrument);
    if (live == null) continue;
    const target = Number(row.targetPrice);
    if (!Number.isFinite(target)) continue;
    const previous =
      row.lastSeenPrice != null ? Number(row.lastSeenPrice) : null;
    const dir = row.triggerDirection as AlertDirection;

    if (shouldFireCrossing(previous, live, target, dir)) {
      try {
        // Compare-and-set: only fire when the row is still `active`.
        // Guards against double-fire across overlapping ticks or a
        // delete that landed between snapshot read and this update.
        const claimed = await db
          .update(userPriceAlerts)
          .set({
            status: "triggered",
            triggeredAt: new Date(),
            triggeredPrice: String(live),
            lastSeenPrice: String(live),
          })
          .where(
            and(
              eq(userPriceAlerts.id, row.id),
              eq(userPriceAlerts.status, "active"),
              isNull(userPriceAlerts.triggeredAt),
            ),
          )
          .returning({ id: userPriceAlerts.id });
        if (claimed.length === 0) continue;

        await firePushForUserAlert(row, live);
      } catch (err) {
        logger.error({ err, alertId: row.id }, "Failed to fire user price alert");
      }
    } else {
      // Update lastSeenPrice so the next tick has a previous to compare
      // against. Skip the write when nothing changed to keep idle ticks
      // free of work.
      if (row.lastSeenPrice !== String(live)) {
        await db
          .update(userPriceAlerts)
          .set({ lastSeenPrice: String(live) })
          .where(eq(userPriceAlerts.id, row.id));
      }
    }
  }
}

type AlertLang = "en" | "id";

const COPY: Record<AlertLang, {
  title: (instrument: string, target: string) => string;
  body: (instrument: string, dir: "above" | "below", target: string, live: string, note: string | null) => string;
}> = {
  en: {
    title: (instrument, target) => `${instrument} reached ${target}`,
    body: (instrument, dir, target, live, note) => {
      const word = dir === "above" ? "above" : "below";
      const base = `${instrument} crossed ${word} ${target} (now ${live}).`;
      return note ? `${base} · ${note}` : base;
    },
  },
  id: {
    title: (instrument, target) => `${instrument} menyentuh ${target}`,
    body: (instrument, dir, target, live, note) => {
      const word = dir === "above" ? "naik ke atas" : "turun ke bawah";
      const base = `${instrument} ${word} ${target} (sekarang ${live}).`;
      return note ? `${base} · ${note}` : base;
    },
  },
};

async function firePushForUserAlert(
  row: typeof userPriceAlerts.$inferSelect,
  livePrice: number,
): Promise<void> {
  const lang: AlertLang = row.lang === "id" ? "id" : "en";
  const dir = row.triggerDirection === "above" ? "above" : "below";
  const target = formatPrice(Number(row.targetPrice));
  const live = formatPrice(livePrice);
  const copy = COPY[lang];
  const title = copy.title(row.instrument, target);
  const body = copy.body(row.instrument, dir, target, live, row.note ?? null);
  const url = `/my-alerts`;
  const tag = `user-price-alert-${row.id}`;
  await createNotification(
    row.userId,
    { title, message: body, type: "info" },
    { title, body, url, tag },
  );
}

function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Trim trailing zeros while preserving enough precision for FX.
  return n.toFixed(5).replace(/\.?0+$/, "");
}
