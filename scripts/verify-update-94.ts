// Throwaway verification for Update 94. Replays the three days found broken on
// 2026-08-03 through the real deriveDayHeader / buildWageLinesForStore.
//   npx tsx scripts/verify-update-94.ts
import { deriveDayHeader } from "../lib/clock-sessions";
import { buildWageLinesForStore, type StoreClockRow } from "../lib/cash-flow";
import type { Employee } from "../lib/types";

const HITCHIN = "ba5fa30b-6d6d-45f4-8cbc-0a962d560763";
const STEVENAGE = "b7506e8d-4eea-4502-8870-e61bbe1775ca";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n        got ${a}\n        want ${e}`}`);
}

const session = (over: Record<string, unknown> = {}) => ({
  clock_in_at: "2026-08-03T10:30:00.000Z",
  clock_out_at: "2026-08-03T21:44:18.392Z",
  hours_approved: true,
  approved_hours: null,
  short_deliveries_count: null,
  long_deliveries_count: null,
  extra_short_deliveries: 0,
  extra_long_deliveries: 0,
  extra_short_reason: null,
  extra_long_reason: null,
  ...over,
});

console.log("\n--- deriveDayHeader: BEFORE the repair (drops on the header only) ---");
const before = deriveDayHeader([session()]);
check("approved short is null, nothing to sum", before.approvedDeliveries.short, null);
check("approved long is null", before.approvedDeliveries.long, null);
check("approved extras are 0", [before.approvedDeliveries.extraShort, before.approvedDeliveries.extraLong], [0, 0]);
check("raw sum is null too — this is what would have erased the header", before.deliveries.short, null);
check("hours were never affected", before.approvedHours! > 0, true);

console.log("\n--- deriveDayHeader: AFTER migration 036 pushes 3/1/1/0 onto the shift ---");
const after = deriveDayHeader([
  session({ short_deliveries_count: 3, long_deliveries_count: 1, extra_short_deliveries: 1, extra_long_deliveries: 0 }),
]);
check("approved short", after.approvedDeliveries.short, 3);
check("approved long", after.approvedDeliveries.long, 1);
check("approved extra short", after.approvedDeliveries.extraShort, 1);
check("approved extra long", after.approvedDeliveries.extraLong, 0);

console.log("\n--- deriveDayHeader: a manager correcting a day to a genuine zero still writes ---");
const zeroed = deriveDayHeader([session({ short_deliveries_count: 0, long_deliveries_count: 0 })]);
check("zero is not null — sessions stay authoritative", zeroed.deliveries.short, 0);

const driver = (id: string, name: string, storeId: string): Employee =>
  ({
    id,
    name,
    position: "Driver",
    store_id: storeId,
    hourly_cash_rate: 6.5,
    bank_weekly_hours_limit: 20,
    short_delivery_rate: 1.2,
    long_delivery_rate: 1.5,
  }) as unknown as Employee;

const clock = (empId: string, storeId: string, approved: [number, number, number, number], hours: number): StoreClockRow => ({
  employee_id: empId,
  store_id: storeId,
  event_date: "2026-08-03",
  clock_in_at: "2026-08-03T10:30:00.000Z",
  clock_out_at: "2026-08-03T21:44:18.392Z",
  short_deliveries_count: null,
  long_deliveries_count: null,
  worked_hours: hours,
  approved_hours: hours,
  approved_short_deliveries_count: approved[0],
  approved_long_deliveries_count: approved[1],
  approved_extra_short_deliveries: approved[2],
  approved_extra_long_deliveries: approved[3],
});

console.log("\n--- buildWageLinesForStore: Mahesh at Hitchin, 10.93h (under the 20h NI limit) ---");
const mahesh = driver("m", "Mahesh Tokala", HITCHIN);
const broken = buildWageLinesForStore(HITCHIN, [mahesh], [clock("m", HITCHIN, [0, 0, 0, 0], 10.93)]);
check("BEFORE: no line at all — he vanishes from the sheet", broken.length, 0);

const fixed = buildWageLinesForStore(HITCHIN, [mahesh], [clock("m", HITCHIN, [10, 4, 2, 3], 10.93)]);
check("AFTER: one line", fixed.length, 1);
check("AFTER: cash hours still 0 (under the NI limit — correct)", fixed[0]?.cash_hours, 0);
// (10 + 2) x 1.20 + (4 + 3) x 1.50 = 14.40 + 10.50
check("AFTER: delivery wages", fixed[0]?.delivery_wages, 24.9);
check("AFTER: total", fixed[0]?.total_payment, 24.9);

console.log("\n--- buildWageLinesForStore: Pavan + Sazid, same fault ---");
const pavan = driver("p", "Pavan", STEVENAGE);
const pFixed = buildWageLinesForStore(STEVENAGE, [pavan], [clock("p", STEVENAGE, [3, 1, 1, 0], 11.4)]);
// (3 + 1) x 1.20 + (1 + 0) x 1.50 = 4.80 + 1.50
check("Pavan delivery wages", pFixed[0]?.delivery_wages, 6.3);

const sazid = driver("s", "Sazid shaik paul", HITCHIN);
const sFixed = buildWageLinesForStore(HITCHIN, [sazid], [clock("s", HITCHIN, [6, 3, 0, 5], 6.65)]);
// (6 + 0) x 1.20 + (3 + 5) x 1.50 = 7.20 + 12.00
check("Sazid delivery wages", sFixed[0]?.delivery_wages, 19.2);

console.log("\n--- control: Chandu was never broken and must not move ---");
const chandu = { ...driver("c", "Chandu", STEVENAGE), hourly_cash_rate: 7 } as Employee;
const cLine = buildWageLinesForStore(STEVENAGE, [chandu], [clock("c", STEVENAGE, [2, 0, 0, 1], 13.93)]);
// (2 + 0) x 1.20 + (0 + 1) x 1.50 = 2.40 + 1.50
check("Chandu delivery wages unchanged", cLine[0]?.delivery_wages, 3.9);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
