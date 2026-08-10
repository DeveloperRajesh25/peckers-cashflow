// Throwaway verification for Update 103 — cover driver MS/ML surviving approval.
// Replays the real mergeCoverDailyApproval and buildCoverDriverWageLines.
//   npx tsx scripts/verify-update-103.ts
import { mergeCoverDailyApproval } from "../lib/cover-driver-hours";
import { buildCoverDriverWageLines, type CoverDriverPayRow } from "../lib/cash-flow";
import type { CoverDriverDaySummary, CoverDriverHoursComputed } from "../lib/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`);
}

// The reported case: a manager records 2 SD / 2 LD / 2 MS / 2 ML via "Add cover
// entry", then approves the day.
const day: CoverDriverDaySummary = {
  cover_driver_id: "cd1",
  driver_name: "Test Driver",
  store_id: "s1",
  work_date: "2026-08-04",
  total_hours: 5,
  short_deliveries: 4,
  long_deliveries: 4,
  short_base: 2,
  long_base: 2,
  extra_short_deliveries: 2,
  extra_long_deliveries: 2,
  extra_short_reason: "Late round",
  extra_long_reason: "Out of area",
  hourly_cash_rate: 10,
  short_delivery_rate: 1,
  long_delivery_rate: 2,
  total_pay: 62,
  auto_clocked_out: false,
  manual_entry: true,
  manual_entry_reason: "Forgot to clock in",
};

const approvedRow = (over: Partial<CoverDriverHoursComputed> = {}): CoverDriverHoursComputed => ({
  id: "h1",
  cover_driver_id: "cd1",
  driver_name: "Test Driver",
  store_id: "s1",
  work_date: "2026-08-04",
  total_hours_worked: 5,
  hourly_rate_snapshot: 10,
  short_deliveries: 2,
  long_deliveries: 2,
  extra_short_deliveries: 2,
  extra_long_deliveries: 2,
  short_rate_snapshot: 1,
  long_rate_snapshot: 2,
  hours_pay: 50,
  short_delivery_pay: 4,
  long_delivery_pay: 8,
  total_pay: 62,
  notes: null,
  approved: true,
  approved_at: "2026-08-05T09:00:00Z",
  source: "clocked",
  created_at: "2026-08-05T09:00:00Z",
  ...over,
});

// ---- before approval: the split is already right, and always was ----
const unapproved = mergeCoverDailyApproval([day], []);
check(
  "unapproved row shows 2/2/2/2",
  [
    unapproved[0].short_deliveries,
    unapproved[0].long_deliveries,
    unapproved[0].extra_short_deliveries,
    unapproved[0].extra_long_deliveries,
  ],
  [2, 2, 2, 2],
);

// ---- after approval: this is what read 4 SD / 4 LD / 0 MS / 0 ML ----
const merged = mergeCoverDailyApproval([day], [approvedRow()]);
check(
  "approved row still shows 2/2/2/2",
  [
    merged[0].short_deliveries,
    merged[0].long_deliveries,
    merged[0].extra_short_deliveries,
    merged[0].extra_long_deliveries,
  ],
  [2, 2, 2, 2],
);
check("approval flag set", merged[0].approved, true);

// An approval with no clocked day in the loaded window still shows its split.
const orphan = mergeCoverDailyApproval([], [approvedRow()]);
check(
  "orphan approval keeps its split",
  [orphan[0].short_deliveries, orphan[0].extra_short_deliveries],
  [2, 2],
);

// ---- the payout: breakdown carried, money unchanged ----
const payRow = (over: Partial<CoverDriverPayRow> = {}): CoverDriverPayRow => ({
  cover_driver_id: "cd1",
  driver_name: "Test Driver",
  store_id: "s1",
  work_date: "2026-08-04",
  total_hours_worked: 5,
  hourly_rate_snapshot: 10,
  short_deliveries: 2,
  long_deliveries: 2,
  extra_short_deliveries: 2,
  extra_long_deliveries: 2,
  short_rate_snapshot: 1,
  long_rate_snapshot: 2,
  approved: true,
  ...over,
});

const [line] = buildCoverDriverWageLines("s1", [payRow()]);
check(
  "payout line carries SD/LD/SM/LM",
  [
    line.short_deliveries_count,
    line.long_deliveries_count,
    line.short_misc_count,
    line.long_misc_count,
  ],
  [2, 2, 2, 2],
);
// 4 short @ £1 + 4 long @ £2 = £12, exactly what the folded total used to pay.
check("delivery wages unchanged at 12", line.delivery_wages, 12);
check("total unchanged at 62", line.total_payment, 62);

// A pre-041 row holds the folded total with extras 0. It must pay identically.
const [legacy] = buildCoverDriverWageLines("s1", [
  payRow({ short_deliveries: 4, long_deliveries: 4, extra_short_deliveries: 0, extra_long_deliveries: 0 }),
]);
check("legacy folded row pays the same", legacy.total_payment, 62);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
