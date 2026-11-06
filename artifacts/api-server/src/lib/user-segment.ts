// Cost/revenue/profit accounting segmentation (product decision — see
// chat). Three MUTUALLY EXCLUSIVE buckets, in this priority order:
//   1. "dev" — admin has ever set a per-user quota override
//      (customQuotaPerDay IS NOT NULL). Treated as an internal/testing
//      account, not real business activity, even if it also has a real
//      top-up on record (e.g. an admin testing the payment flow).
//   2. "paid" — not dev, and has at least one "topup_approval"
//      credit_ledger entry ever (lifetime, regardless of current
//      balance — reusing the same ledger the credit-balance feature
//      already tracks, not a separate signal).
//   3. "free" — everyone else.
//
// Centralized here (rather than duplicated per route) so GET /admin/stats'
// totals, GET /superadmin/users' per-row segment + ?segment= filter, and
// GET /admin/analytics/tokens' bySegment breakdown can never drift apart.
import { sql } from "drizzle-orm";
import { creditLedger, users } from "@workspace/db/schema";

export const USER_SEGMENTS = ["free", "paid", "dev"] as const;
export type UserSegment = (typeof USER_SEGMENTS)[number];

export function isUserSegment(value: unknown): value is UserSegment {
  return typeof value === "string" && (USER_SEGMENTS as readonly string[]).includes(value);
}

const HAS_TOPUP_SQL = sql`EXISTS (
  SELECT 1 FROM ${creditLedger}
  WHERE ${creditLedger.userId} = ${users.id}
    AND ${creditLedger.source} = 'topup_approval'
)`;

/** A `CASE ... END` SQL expression computing one user's segment — use the
 *  exact same object in both a SELECT list and a GROUP BY so the rendered
 *  SQL text matches (Postgres groups by expression text, not identity). */
export const userSegmentCaseSql = sql<UserSegment>`case
  when ${users.customQuotaPerDay} is not null then 'dev'
  when ${HAS_TOPUP_SQL} then 'paid'
  else 'free'
end`;

export function segmentFilterClause(segment: UserSegment) {
  if (segment === "dev") return sql`${users.customQuotaPerDay} IS NOT NULL`;
  if (segment === "paid") return sql`${users.customQuotaPerDay} IS NULL AND ${HAS_TOPUP_SQL}`;
  return sql`${users.customQuotaPerDay} IS NULL AND NOT ${HAS_TOPUP_SQL}`;
}
