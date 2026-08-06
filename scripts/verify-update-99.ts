// Throwaway verification for Update 97 — the manual payout adjustment.
// Replays the settle through the real buildPrePaymentSummary and the real
// normalisePayoutAdjustment.
//   npx tsx scripts/verify-update-97.ts
import {
  buildPrePaymentSummary,
  normalisePayoutAdjustment,
  MAX_PAYOUT_ADJUSTMENT,
} from "../lib/cash-flow";
import type { WageLine } from "../lib/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`);
}
function throws(label: string, fn: () => unknown, expectMatch: string) {
  try {
    fn();
    failures++;
    console.log(`FAIL  ${label}\n        expected a throw, got none`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ok = msg.toLowerCase().includes(expectMatch.toLowerCase());
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got "${msg}"`}`);
  }
}

const wage = (cash: number, delivery: number): WageLine => ({
  employee_id: "e1",
  employee_name: "Test",
  role: "Driver",
  cash_hours: 10,
  cash_rate: 10,
  cash_wage: cash,
  short_deliveries_count: 0,
  long_deliveries_count: 0,
  short_misc_count: 0,
  long_misc_count: 0,
  short_delivery_rate: 0,
  long_delivery_rate: 0,
  delivery_wages: delivery,
  total_payment: cash + delivery,
});

// opening 100 + envelopes 900 + supermarket 350 = 1350 available.
// wages 400 cash + 100 delivery = 500 due.  Baseline surplus = 850.
const base = {
  store_id: "s1",
  week_start_date: "2026-08-10",
  opening_balance: 100,
  entries: [{ vita_mojo_sales: 1000, envelope_amount: 900, difference: 100 }],
  lines: [wage(400, 100)],
  supermarket_cash: 350,
};

console.log("\n--- Baseline: no adjustment (must be byte-identical to before) ---");
const none = buildPrePaymentSummary(base);
check("actual cash available = 100 + 900 + 350", none.actual_cash_available, 1350);
check("grand total wages", none.grand_total_wages, 500);
check("surplus 850", none.surplus, 850);
check("no draw", none.post_office_draw, 0);
check("adjustment defaults to 0", none.adjustment, 0);
check("no reason", none.adjustment_reason, null);

console.log("\n--- POSITIVE adjustment: cash added to the pot ---");
const plus = buildPrePaymentSummary({ ...base, adjustment: 200, adjustment_reason: "Owner float" });
check("actual cash available is UNCHANGED", plus.actual_cash_available, 1350);
check("surplus grows by the adjustment", plus.surplus, 1050);
check("still no draw", plus.post_office_draw, 0);
check("amount and reason carried", [plus.adjustment, plus.adjustment_reason], [200, "Owner float"]);

console.log("\n--- NEGATIVE adjustment: cash taken out ---");
const minus = buildPrePaymentSummary({ ...base, adjustment: -200, adjustment_reason: "Paid supplier" });
check("actual cash available is UNCHANGED", minus.actual_cash_available, 1350);
check("surplus shrinks by the adjustment", minus.surplus, 650);
check("still no draw", minus.post_office_draw, 0);

console.log("\n--- A negative adjustment can CREATE a Post Office draw ---");
const intoDraw = buildPrePaymentSummary({ ...base, adjustment: -1000, adjustment_reason: "Cash removed" });
check("surplus gone", intoDraw.surplus, 0);
check("draw = 500 + 1000 - 1350 = 150", intoDraw.post_office_draw, 150);

console.log("\n--- A positive adjustment can CLEAR a Post Office draw ---");
// Shrink the pot so a draw exists first: envelopes 0 => available = 100+0+350 = 450 vs 500 due.
const shortBase = { ...base, entries: [{ vita_mojo_sales: 0, envelope_amount: 0, difference: 0 }] };
const short = buildPrePaymentSummary(shortBase);
check("baseline draw of 50", short.post_office_draw, 50);
const rescued = buildPrePaymentSummary({ ...shortBase, adjustment: 50, adjustment_reason: "Topped up" });
check("draw exactly cleared", rescued.post_office_draw, 0);
check("and no phantom surplus at the boundary", rescued.surplus, 0);
const overRescued = buildPrePaymentSummary({ ...shortBase, adjustment: 130, adjustment_reason: "Topped up" });
check("beyond break-even becomes surplus", [overRescued.post_office_draw, overRescued.surplus], [0, 80]);

console.log("\n--- Rounding: pennies must not drift ---");
const pennies = buildPrePaymentSummary({ ...base, adjustment: 0.005, adjustment_reason: "x" });
check("adjustment rounds to 2dp", pennies.adjustment, 0.01);

console.log("\n--- normalisePayoutAdjustment ---");
check("zero clears the reason", normalisePayoutAdjustment(0, "stale text"), { amount: 0, reason: null });
check("blank amount is zero, not NaN", normalisePayoutAdjustment("", null), { amount: 0, reason: null });
check("negative accepted with a reason", normalisePayoutAdjustment(-50, " Paid supplier "), {
  amount: -50,
  reason: "Paid supplier",
});
check("rounds to 2dp", normalisePayoutAdjustment(12.345, "x"), { amount: 12.35, reason: "x" });
throws("non-zero with no reason is refused", () => normalisePayoutAdjustment(50, null), "reason");
throws("non-zero with whitespace reason is refused", () => normalisePayoutAdjustment(50, "   "), "reason");
throws("above the bound is refused", () => normalisePayoutAdjustment(MAX_PAYOUT_ADJUSTMENT + 1, "x"), "looks wrong");
throws("below the negative bound is refused", () => normalisePayoutAdjustment(-(MAX_PAYOUT_ADJUSTMENT + 1), "x"), "looks wrong");
check("exactly at the bound is allowed", normalisePayoutAdjustment(MAX_PAYOUT_ADJUSTMENT, "big one").amount, MAX_PAYOUT_ADJUSTMENT);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
