// Throwaway verification for Update 95 — a manager's missed deliveries.
// Replays the deliveries-only session through the real deriveDayHeader (the
// same two-call split recomputeManagerDayHeader performs) and the real
// buildManagerWageLines.
//   npx tsx scripts/verify-update-95.ts
import { deriveDayHeader } from "../lib/clock-sessions";
import { buildManagerWageLines, type ManagerPayRow } from "../lib/cash-flow";

const STORE = "b7506e8d-4eea-4502-8870-e61bbe1775ca";
const OTHER_STORE = "ba5fa30b-6d6d-45f4-8cbc-0a962d560763";
const MGR = "11111111-1111-1111-1111-111111111111";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`);
}

type Sess = {
  clock_in_at: string;
  clock_out_at: string | null;
  deliveries_only?: boolean;
  hours_approved?: boolean;
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number;
  extra_long_deliveries?: number;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
};

/** Exactly what recomputeManagerDayHeader writes, given a day's sessions. */
function headerFor(sessions: Sess[]) {
  const timed = deriveDayHeader(sessions.filter((s) => !s.deliveries_only));
  const all = deriveDayHeader(sessions);
  return {
    clock_in_at: timed.firstIn,
    clock_out_at: timed.lastOut,
    worked_hours: timed.completedCount > 0 ? timed.workedHours : null,
    session_count: timed.sessionCount,
    short: all.deliveries.short,
    long: all.deliveries.long,
    extra_short: all.deliveries.extraShort,
    approved_short: all.approvedDeliveries.short,
    approved_long: all.approvedDeliveries.long,
    approved_extra_short: all.approvedDeliveries.extraShort,
    deliveries_approved: all.allApproved,
  };
}

const NOON = "2026-08-03T11:00:00.000Z"; // 12:00 London
const dropsOnly = (over: Partial<Sess> = {}): Sess => ({
  clock_in_at: NOON,
  clock_out_at: NOON,
  deliveries_only: true,
  hours_approved: false,
  short_deliveries_count: 6,
  long_deliveries_count: 2,
  extra_short_deliveries: 0,
  extra_long_deliveries: 0,
  extra_short_reason: null,
  extra_long_reason: null,
  ...over,
});

console.log("\n--- A day with ONLY hand-entered deliveries ---");
const alone = headerFor([dropsOnly()]);
check("no clock-in is invented", alone.clock_in_at, null);
check("no clock-out either", alone.clock_out_at, null);
check("worked hours stay null — nothing was clocked", alone.worked_hours, null);
check("the day holds no shifts", alone.session_count, 0);
check("the drops are on the day", [alone.short, alone.long], [6, 2]);
check("unapproved, so nothing payable yet", alone.approved_short, null);
check("day does not read as approved", alone.deliveries_approved, false);

console.log("\n--- The same day, once approved ---");
const approved = headerFor([dropsOnly({ hours_approved: true })]);
check("approved drops are the payable figure", [approved.approved_short, approved.approved_long], [6, 2]);
check("still no clock times", [approved.clock_in_at, approved.worked_hours], [null, null]);
check("day reads approved", approved.deliveries_approved, true);

console.log("\n--- Hand-entered drops ALONGSIDE a real shift ---");
const mixed = headerFor([
  {
    clock_in_at: "2026-08-03T08:00:00.000Z",
    clock_out_at: "2026-08-03T16:00:00.000Z",
    hours_approved: true,
    short_deliveries_count: 3,
    long_deliveries_count: 1,
    extra_short_deliveries: 0,
    extra_long_deliveries: 0,
  },
  dropsOnly({ hours_approved: true, short_deliveries_count: 6, long_deliveries_count: 2 }),
]);
check("the real shift keeps the day's bounds", mixed.clock_in_at, "2026-08-03T08:00:00.000Z");
check("the zero-length row adds no hours", mixed.worked_hours, 8);
check("and is not counted as a shift", mixed.session_count, 1);
check("but its drops are summed in", [mixed.short, mixed.long], [9, 3]);
check("approved figure sums both", [mixed.approved_short, mixed.approved_long], [9, 3]);

console.log("\n--- Hand-entered drops while a real shift is still OPEN ---");
const midShift = headerFor([
  {
    clock_in_at: "2026-08-03T15:00:00.000Z",
    clock_out_at: null,
    hours_approved: false,
    short_deliveries_count: null,
    long_deliveries_count: null,
  },
  dropsOnly({ hours_approved: true }),
]);
check("the day stays open", midShift.clock_out_at, null);
check("worked hours stay null while nothing has completed", midShift.worked_hours, null);
check("the hand-entered drops are still payable", [midShift.approved_short, midShift.approved_long], [6, 2]);

console.log("\n--- buildManagerWageLines pays the approved day ---");
const payRow = (over: Partial<ManagerPayRow> = {}): ManagerPayRow => ({
  manager_id: MGR,
  store_id: STORE,
  event_date: "2026-08-03",
  approved_short_deliveries_count: approved.approved_short,
  approved_long_deliveries_count: approved.approved_long,
  approved_extra_short_deliveries: approved.approved_extra_short,
  approved_extra_long_deliveries: 0,
  ...over,
});
const payee = { id: MGR, name: "Ravi", short_delivery_rate: 3, long_delivery_rate: 5 };

const paid = buildManagerWageLines(STORE, [payee], [payRow()]);
check("one line", paid.length, 1);
check("6 × £3 + 2 × £5 = £28", paid[0]?.total_payment, 28);
check("hours stay zero — salary never comes through here", [paid[0]?.cash_hours, paid[0]?.cash_wage], [0, 0]);
check("line carries the manager, not an employee", [paid[0]?.manager_id, paid[0]?.employee_id], [MGR, ""]);

const unapprovedRow = payRow({
  approved_short_deliveries_count: alone.approved_short,
  approved_long_deliveries_count: alone.approved_long,
  approved_extra_short_deliveries: alone.approved_extra_short,
});
check("an UNAPPROVED day produces no line", buildManagerWageLines(STORE, [payee], [unapprovedRow]).length, 0);
check(
  "a day recorded at another store isn't on this sheet",
  buildManagerWageLines(STORE, [payee], [payRow({ store_id: OTHER_STORE })]).length,
  0,
);
check(
  "no rates on file falls back to the petrol rate, never zero",
  buildManagerWageLines(STORE, [{ id: MGR, name: "Ravi" }], [payRow()])[0]?.total_payment,
  16,
);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
