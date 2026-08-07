// Throwaway verification for Update 102 — separate MISC delivery rates for
// managers. Runs the REAL buildManagerWageLines / buildWageLinesForStore, so
// this proves the shipped maths, not a copy of it.
//   npx tsx scripts/verify-update-102.ts
import {
  buildManagerWageLines,
  buildWageLinesForStore,
  type ManagerPayRow,
  type ManagerPayee,
} from "../lib/cash-flow";
import type { Employee } from "../lib/types";

const STORE = "b7506e8d-4eea-4502-8870-e61bbe1775ca";
const MGR = "11111111-1111-1111-1111-111111111111";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`,
  );
}

// 10 SD, 4 LD, 6 MS, 2 ML — all approved.
const day: ManagerPayRow = {
  manager_id: MGR,
  store_id: STORE,
  event_date: "2026-08-04",
  approved_short_deliveries_count: 10,
  approved_long_deliveries_count: 4,
  approved_extra_short_deliveries: 6,
  approved_extra_long_deliveries: 2,
};

const base: ManagerPayee = {
  id: MGR,
  name: "Ravi",
  short_delivery_rate: 2,
  long_delivery_rate: 5,
};

// ---- 1. No misc rates set: must match the pre-040 figure exactly ----------
// Old maths: (10 + 6) * 2 + (4 + 2) * 5 = 32 + 30 = 62
{
  const [line] = buildManagerWageLines(STORE, [base], [day]);
  check("unset misc rates reproduce pre-040 total", line.delivery_wages, 62);
  check("misc short rate falls back to SD rate", line.short_misc_rate, 2);
  check("misc long rate falls back to LD rate", line.long_misc_rate, 5);
}

// ---- 2. Misc rates set: extras priced on their own ------------------------
// 10*2 + 4*5 + 6*0.5 + 2*1 = 20 + 20 + 3 + 2 = 45
{
  const payee: ManagerPayee = {
    ...base,
    extra_short_delivery_rate: 0.5,
    extra_long_delivery_rate: 1,
  };
  const [line] = buildManagerWageLines(STORE, [payee], [day]);
  check("misc rates price the extras separately", line.delivery_wages, 45);
  check("snapshot carries the misc short rate", line.short_misc_rate, 0.5);
  check("snapshot carries the misc long rate", line.long_misc_rate, 1);
  check("base rates unchanged on the line", line.short_delivery_rate, 2);
  check("counts still split SD/LD/MS/ML", [
    line.short_deliveries_count,
    line.long_deliveries_count,
    line.short_misc_count,
    line.long_misc_count,
  ], [10, 4, 6, 2]);
}

// ---- 3. Only ONE misc rate set: the other still falls back ----------------
// 10*2 + 4*5 + 6*0.5 + 2*5 = 20 + 20 + 3 + 10 = 53
{
  const payee: ManagerPayee = { ...base, extra_short_delivery_rate: 0.5 };
  const [line] = buildManagerWageLines(STORE, [payee], [day]);
  check("half-set misc rates fall back independently", line.delivery_wages, 53);
}

// ---- 4. No base rate either: misc falls back to the petrol rate -----------
// DELIVERY_PETROL_RATE applies to all four: (10+4+6+2) * rate
{
  const payee: ManagerPayee = { id: MGR, name: "Ravi" };
  const [line] = buildManagerWageLines(STORE, [payee], [day]);
  const rate = line.short_delivery_rate;
  check("misc inherits the petrol-rate fallback", line.delivery_wages, 22 * rate);
  check("misc rate equals the petrol fallback", line.short_misc_rate, rate);
}

// ---- 5. Employees are UNTOUCHED: misc still pays at the base rate ---------
// (10 + 6) * 2 + (4 + 2) * 5 = 62, and no misc rate on the line.
{
  const emp = {
    id: "emp-1",
    name: "Driver Dan",
    position: "Driver",
    store_id: STORE,
    hourly_cash_rate: 0,
    hourly_ni_rate: 0,
    bank_weekly_hours_limit: 20,
    short_delivery_rate: 2,
    long_delivery_rate: 5,
  } as unknown as Employee;
  const [line] = buildWageLinesForStore(STORE, [emp], [
    {
      employee_id: "emp-1",
      store_id: STORE,
      event_date: "2026-08-04",
      clock_in_at: null,
      clock_out_at: null,
      worked_hours: 0,
      hours_approved: true,
      approved_hours: 0,
      short_deliveries_count: 10,
      long_deliveries_count: 4,
      extra_short_deliveries: 6,
      extra_long_deliveries: 2,
      approved_short_deliveries_count: 10,
      approved_long_deliveries_count: 4,
      approved_extra_short_deliveries: 6,
      approved_extra_long_deliveries: 2,
    },
  ]);
  check("employee misc still pays at the base rate", line.delivery_wages, 62);
  check("employee line carries no misc rate", line.short_misc_rate ?? null, null);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
