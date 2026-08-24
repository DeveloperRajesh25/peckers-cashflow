// Throwaway verification for Update 136 — many adjustments per payout week.
// Replays the settle through the real buildPrePaymentSummary plus the roll-up
// helpers the server action writes onto the payout header.
//   npx tsx scripts/verify-update-136.ts
import {
  buildPrePaymentSummary,
  normalisePayoutAdjustment,
  sumAdjustments,
  summariseAdjustmentReasons,
} from "../lib/cash-flow";
import type { PrePaymentAdjustment, WageLine } from "../lib/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`);
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

const adj = (amount: number, reason: string): PrePaymentAdjustment => ({
  id: `a-${reason}`,
  amount,
  reason,
});

console.log("\n--- Baseline: no adjustments at all (unchanged from before) ---");
const none = buildPrePaymentSummary(base);
check("surplus 850", none.surplus, 850);
check("adjustment 0", none.adjustment, 0);
check("no reason", none.adjustment_reason, null);
check("empty list", none.adjustments, []);

console.log("\n--- The old single-adjustment call still settles identically ---");
const single = buildPrePaymentSummary({ ...base, adjustment: 200, adjustment_reason: "Paid supplier" });
check("surplus shrinks by 200", single.surplus, 650);
check("amount + reason carried", [single.adjustment, single.adjustment_reason], [200, "Paid supplier"]);

console.log("\n--- One ENTRY settles exactly like the old single figure ---");
const oneEntry = buildPrePaymentSummary({ ...base, adjustments: [adj(200, "Paid supplier")] });
check("surplus identical to the single-figure call", oneEntry.surplus, single.surplus);
check("draw identical", oneEntry.post_office_draw, single.post_office_draw);
check("total identical", oneEntry.adjustment, single.adjustment);

console.log("\n--- MANY entries: the settle applies their signed sum, once ---");
const many = buildPrePaymentSummary({
  ...base,
  adjustments: [adj(200, "Paid supplier"), adj(-50, "Owner float in"), adj(120.5, "Till short")],
});
check("total = 200 - 50 + 120.50", many.adjustment, 270.5);
check("surplus 850 - 270.50", many.surplus, 579.5);
check("no draw", many.post_office_draw, 0);
check("reasons joined for the header", many.adjustment_reason, "Paid supplier · Owner float in · Till short");
check("entries carried through to the sheet", many.adjustments.length, 3);

console.log("\n--- Entries whose signs cancel leave the week untouched ---");
const cancel = buildPrePaymentSummary({ ...base, adjustments: [adj(300, "Out"), adj(-300, "Back in")] });
check("total 0", cancel.adjustment, 0);
check("surplus back to baseline", cancel.surplus, 850);
check("both entries still listed", cancel.adjustments.length, 2);

console.log("\n--- Entries can together CREATE a Post Office draw ---");
const draw = buildPrePaymentSummary({ ...base, adjustments: [adj(600, "Supplier"), adj(400, "Rent")] });
check("draw = 1000 - 850", draw.post_office_draw, 150);
check("surplus 0", draw.surplus, 0);

console.log("\n--- Entries take precedence over a stale single figure ---");
const both = buildPrePaymentSummary({
  ...base,
  adjustment: 9999,
  adjustment_reason: "stale",
  adjustments: [adj(100, "Real movement")],
});
check("total from the entries", both.adjustment, 100);
check("reason from the entries", both.adjustment_reason, "Real movement");

console.log("\n--- Roll-up helpers (what the header column is written from) ---");
check("sum rounds to 2dp", sumAdjustments([{ amount: 0.005 }, { amount: 0.005 }]), 0.01);
check("sum of none is 0", sumAdjustments([]), 0);
check("no rows → null reason", summariseAdjustmentReasons([]), null);
check("blank reasons dropped", summariseAdjustmentReasons([{ reason: " " }, { reason: "Real" }]), "Real");

console.log("\n--- Per-entry validation is unchanged ---");
check("0 clears the reason (how the sheet deletes one)", normalisePayoutAdjustment(0, "x"), { amount: 0, reason: null });
check("reason trimmed", normalisePayoutAdjustment(12.345, "  Float  "), { amount: 12.35, reason: "Float" });

console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
