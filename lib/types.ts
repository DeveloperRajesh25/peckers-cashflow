export type StoreCode = "stevenage" | "hitchin";

/**
 * Standard result for user-triggered server actions. User-facing failures are
 * RETURNED (not thrown): Next.js masks thrown error messages in production
 * builds, so a thrown "You're 300m from the store" would reach the user as a
 * useless generic "Server Components render" error.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Per-store rota preset times (HH:MM, 24h). Mirrors lib/settings ShiftTimeSettings. */
export type StoreShiftTimes = {
  driver_open: string;
  kitchen_open: string;
  evening_start: string;
  close: string;
};

export type Store = {
  id: string;
  code: StoreCode;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m: number;
  /** Open/Evening/Close times used by this store's rota presets. */
  shift_times: StoreShiftTimes;
  created_at: string;
};

export type AllowedUserRole = "admin" | "manager" | "employee" | "cover_driver";

export type AllowedUser = {
  id: string;
  /** Login identity. Synthetic (`<username>@staff.peckers-app.co.uk`) for
   *  managers/crew, a real address for admins. NOT a mailbox — see contact_email. */
  email: string;
  /** The person's REAL email, used only to send password-reset links. Unique
   *  across all accounts. Null for staff provisioned before migration 019 who
   *  haven't added one yet — they can't self-reset until they do. */
  contact_email: string | null;
  name: string | null;
  role: AllowedUserRole;
  /** The manager's HOME store — where they belong and, by default, where they
   *  act. Set once by an admin. */
  store_id: string | null;
  /** The store a manager is currently OPERATING AS (multi-store switching).
   *  Null = use the home store. Only meaningful for managers; resolve via
   *  {@link resolveActiveStoreId} rather than reading this directly. */
  active_store_id: string | null;
  username: string | null;
  temp_password: string | null;
  must_change_password: boolean;
  employee_id: string | null;
  /** Links a 'cover_driver' login to its cover_drivers profile row. */
  cover_driver_id: string | null;
  /** A manager's FIXED daily wage (£). Monitoring/display only — never
   *  drives any pay calculation. Null for admins/employees or if unset. */
  fixed_daily_wage: number | null;
  /**
   * Per-drop rates for a manager who covers deliveries on a busy night
   * (migration 034). Unlike fixed_daily_wage these DO drive pay: the drops are
   * settled in cash on the Tuesday sheet. Null falls back to
   * DELIVERY_PETROL_RATE, exactly as an employee with no rate on file does.
   */
  short_delivery_rate: number | null;
  long_delivery_rate: number | null;
  /**
   * Per-drop rates for a manager's MISC drops — the extras beyond the normal
   * round (migration 040). Managers only: employees and cover drivers pay
   * their misc drops at the base rate. Null falls back to the base rate above,
   * so leaving these unset reproduces the pre-040 maths exactly.
   */
  extra_short_delivery_rate: number | null;
  extra_long_delivery_rate: number | null;
  created_at: string;
};

/**
 * The store a login account is currently acting on. For managers this is their
 * ACTIVE store (the one they've switched to) falling back to their home store;
 * for everyone else it's just their store_id. This is the single source pages
 * and actions should use to scope a manager's data — never read
 * `allowed.store_id` directly for that, or a switched manager will see the
 * wrong store. Mirrors the DB's current_user_store_id() (migration 020) so the
 * app layer and RLS agree.
 */
export function resolveActiveStoreId(allowed: AllowedUser | null | undefined): string | null {
  return allowed?.active_store_id ?? allowed?.store_id ?? null;
}

/** Which portal a role lands in. */
export type Portal = "admin" | "manager" | "employee" | "cover_driver";

/** Home route for each role's portal. */
export const PORTAL_HOME: Record<AllowedUserRole, string> = {
  admin: "/dashboard",
  manager: "/manager/live",
  employee: "/employee/attendance",
  cover_driver: "/cover-driver/attendance",
};

/** The login page for each portal. */
export const PORTAL_LOGIN: Record<Portal, string> = {
  admin: "/login",
  manager: "/manager/login",
  employee: "/employee/login",
  cover_driver: "/cover-driver/login",
};

export type CashEntry = {
  id: string;
  user_id: string | null;
  entry_date: string;
  cash_sales: number;
  supermarket_expenses: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type CashEntryWithManager = CashEntry & {
  manager_name: string | null;
  manager_email: string | null;
};

export type EmploymentStatus = "active" | "inactive" | "left";

export type EmployeePosition =
  | "Manager"
  | "KTM (Supervisor)"
  | "Kitchen Team Member"
  | "Driver"
  | "Supervisor";

// "Manager" is intentionally excluded — managers are provisioned separately
// (not employees), so they must not be selectable as an employee position.
// The type above still allows "Manager" so any legacy record keeps rendering.
export const POSITION_OPTIONS: EmployeePosition[] = [
  "KTM (Supervisor)",
  "Kitchen Team Member",
  "Driver",
  "Supervisor",
];

export type Employee = {
  id: string;
  name: string;
  phone: string | null;
  hourly_rate: number;
  bank_weekly_hours_limit: number;
  is_active: boolean;
  joined_date: string | null;
  notes: string | null;
  created_at: string;
  // Stage 1 additions
  date_of_birth: string | null;
  gender: string | null;
  position: EmployeePosition | null;
  employment_start_date: string | null;
  hourly_ni_rate: number | null;
  hourly_cash_rate: number | null;
  store_id: string | null;
  bank_account_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  sort_code: string | null;
  employment_status: EmploymentStatus;
  auth_user_id: string | null;
  /** Synthetic LOGIN address (`<username>@staff.peckers-app.co.uk`), not a
   *  mailbox. Set once at provisioning; never edit it from the profile form. */
  email: string | null;
  /** DERIVED — not an employees column. The linked allowed_users.contact_email
   *  (their real inbox, where reset links go), merged in by withContactEmails().
   *  Undefined on rows from queries that don't merge it. */
  contact_email?: string | null;
  /** Per-driver £/delivery rate for SHORT deliveries. Null for non-drivers. */
  short_delivery_rate: number | null;
  /** Per-driver £/delivery rate for LONG deliveries. Null for non-drivers. */
  long_delivery_rate: number | null;
};

/**
 * The employee columns the Daily Approval and Weekly Log tabs read. The full
 * row — bank details, DOB, contact email — is only ever rendered on the
 * Employees (cards) tab, so it is fetched when that tab is opened.
 */
export type EmployeeSummary = Pick<
  Employee,
  | "id"
  | "name"
  | "position"
  | "store_id"
  | "employment_status"
  | "is_active"
  | "hourly_rate"
  | "hourly_ni_rate"
>;

/** Parse pipe-delimited positions string into array. */
export function parsePositions(positionStr: string | null): EmployeePosition[] {
  if (!positionStr) return [];
  return positionStr.split("|").filter((p) => p.trim() && POSITION_OPTIONS.includes(p.trim() as EmployeePosition)) as EmployeePosition[];
}

/** Check if employee has a specific role. */
export function hasRole(positionStr: string | null, role: EmployeePosition): boolean {
  return parsePositions(positionStr).includes(role);
}

export type EmployeeHoursSource = "manual" | "clocked";

export type EmployeeHoursRow = {
  id: string;
  employee_id: string;
  week_start_date: string;
  total_hours_worked: number;
  hourly_rate_snapshot: number;
  notes: string | null;
  logged_by: string | null;
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  source: EmployeeHoursSource;
  created_at: string;
};

export type EmployeeHoursComputed = {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_phone: string | null;
  week_start_date: string;
  total_hours_worked: number;
  bank_hours: number;
  cash_hours: number;
  cash_amount_due: number;
  hourly_rate_snapshot: number;
  notes: string | null;
  logged_by: string | null;
  approved: boolean;
  approved_at: string | null;
  source: EmployeeHoursSource;
  created_at: string;
};

// One ad-hoc payment to a part-time "cover driver" (not a permanent employee).
/**
 * A part-time cover driver. Deliberately NOT an `employees` row — cover drivers
 * must never appear in the rota, live board, payouts, NI or analytics, and
 * keeping them in their own table is what guarantees that.
 *
 * Cash-only by design: there is no NI rate and no 20h bank/cash split.
 */
export type CoverDriver = {
  id: string;
  store_id: string;
  name: string;
  phone: string | null;
  date_of_birth: string | null;
  hourly_cash_rate: number;
  short_delivery_rate: number | null;
  long_delivery_rate: number | null;
  email: string | null;
  auth_user_id: string | null;
  is_active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * A cover driver's shift on a SPECIFIC date — the per-date override of their
 * weekly availability. Mirrors ManagerShift: like a manager, a cover driver is
 * not an `employees` row, so this keys on its own parent table.
 */
export type CoverDriverShift = {
  id: string;
  cover_driver_id: string;
  store_id: string;
  shift_date: string;
  start_time: string | null;
  end_time: string | null;
  is_day_off: boolean;
  scheduled_hours: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/**
 * One weekday of a cover driver's recurring availability — the fallback shown
 * when no CoverDriverShift exists for a date. Availability, not a booking: it
 * pre-fills a rota cell but never creates one on its own (there is no
 * applyScheduleToWeek equivalent for cover drivers).
 */
export type CoverDriverScheduleDay = {
  id: string;
  cover_driver_id: string;
  weekday: number;
  is_working: boolean;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  updated_at: string;
};

export type CoverDriverClockEvent = {
  id: string;
  cover_driver_id: string;
  store_id: string;
  event_date: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  short_deliveries_count: number | null;
  long_deliveries_count: number | null;
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
  /** Set when the nightly sweep closed a forgotten clock-out (see lib/auto-clock-out). */
  auto_clocked_out?: boolean;
  auto_clock_out_source?: string | null;
  auto_clock_out_at?: string | null;
  /** Set when a manager recorded these times by hand — NOT geofence-verified. */
  manual_entry?: boolean;
  manual_entry_by?: string | null;
  manual_entry_at?: string | null;
  manual_entry_reason?: string | null;
  /** 'in' | 'out' | 'both' — which timestamps the manager supplied. */
  manual_entry_fields?: string | null;
  created_at: string;
};

/** Row of `cover_driver_hours_computed`. Approved pay for one driver-day. */
export type CoverDriverHoursComputed = {
  id: string;
  cover_driver_id: string;
  driver_name: string;
  store_id: string;
  work_date: string;
  total_hours_worked: number;
  hourly_rate_snapshot: number;
  /** The normal round. Extras are snapshotted separately (migration 041). */
  short_deliveries: number;
  long_deliveries: number;
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  short_rate_snapshot: number | null;
  long_rate_snapshot: number | null;
  hours_pay: number;
  short_delivery_pay: number;
  long_delivery_pay: number;
  total_pay: number;
  notes: string | null;
  approved: boolean;
  approved_at: string | null;
  source: "clocked" | "manual";
  created_at: string;
};

/**
 * One completed cover-driver clock day, summarised for the admin tables.
 * Employees summarise per ISO week; cover drivers are per DAY.
 */
export type CoverDriverDaySummary = {
  cover_driver_id: string;
  driver_name: string;
  store_id: string;
  work_date: string;
  total_hours: number;
  /** Base + extra, as paid. Split out below for editing. */
  short_deliveries: number;
  long_deliveries: number;
  /** The normal round on its own, as recorded on the clock event. */
  short_base: number;
  long_base: number;
  /** Beyond the round; each requires a written reason above zero. */
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
  hourly_cash_rate: number;
  short_delivery_rate: number | null;
  long_delivery_rate: number | null;
  /** hours * rate + deliveries * per-type rate. */
  total_pay: number;
  auto_clocked_out: boolean;
  manual_entry: boolean;
  manual_entry_reason: string | null;
};

/**
 * A cover driver's day as the Daily Approval screen sees it: the clocked day
 * merged with its approval, so cover rows sit alongside employee rows there.
 */
export type CoverDailyApprovalRow = {
  cover_driver_id: string;
  driver_name: string;
  store_id: string;
  work_date: string;
  clocked_hours: number;
  approved: boolean;
  /** Hours as signed off, which may differ from clocked if a manager adjusted. */
  approved_hours: number | null;
  /** cover_driver_hours row id — needed to undo an approval. */
  approved_row_id: string | null;
  auto_clocked_out: boolean;
  manual_entry: boolean;
  manual_entry_reason: string | null;
  /**
   * The day's drops, editable on the approval row. Correcting them here
   * REWRITES the clock event before the approval snapshots the rates — the
   * only manager path to fix a cover driver's counts after clock-out.
   */
  short_deliveries: number;
  long_deliveries: number;
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
};

/**
 * Which rota preset produced a shift's times. Null = custom times entered by
 * hand, a day off, or a legacy/auto-created shift.
 *  - open_close:    open (11:30 driver / 09:00 kitchen) → close (23:00)
 *  - evening_close: evening (17:00) → close (23:00)
 * The exact times are configurable in Settings (`shift_times`).
 */
export type ShiftPreset = "open_close" | "evening_close";

export type RotaShift = {
  id: string;
  employee_id: string;
  store_id: string;
  shift_date: string;
  start_time: string | null;
  end_time: string | null;
  is_day_off: boolean;
  scheduled_hours: number;
  shift_type: ShiftPreset | null;
  manager_notes: string | null;
  same_day_edit_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/**
 * A prior-weeks shift, carrying only what the Rota's 4-week rolling average
 * reads. The average spans every store, so the history can't be store-scoped —
 * narrowing the columns is what keeps it off the critical path instead.
 */
export type RotaHistoryShift = Pick<
  RotaShift,
  "employee_id" | "shift_date" | "scheduled_hours" | "is_day_off"
>;

/**
 * One day of an employee's recurring weekly schedule template.
 * weekday: 0=Mon .. 6=Sun (matches `weekdayIndex` in lib/utils).
 * This is the contracted/default pattern — the baseline the rota is generated
 * from and that actual clock-in/out is compared against.
 */
export type EmployeeScheduleDay = {
  id: string;
  employee_id: string;
  weekday: number;
  is_working: boolean;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  updated_at: string;
};

export type ClockEvent = {
  id: string;
  employee_id: string;
  shift_id: string | null;
  store_id: string;
  event_date: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  short_deliveries_count: number | null;
  long_deliveries_count: number | null;
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
  created_at: string;
  /** Manager approval of this day's clocked hours — see components/employees/DailyHoursApproval.tsx. */
  hours_approved?: boolean | null;
  /** Manager-confirmed hours for the day (may differ from the raw clock_in/out delta). Authoritative once hours_approved is true. */
  approved_hours?: number | null;
  /** True when the system closed this day because the clock-out was forgotten — see lib/auto-clock-out.ts. */
  auto_clocked_out?: boolean | null;
  /** Where the assumed clock-out time came from: 'rota' | 'schedule' | 'store_close' | 'fallback'. */
  auto_clock_out_source?: string | null;
  /**
   * True when a manager recorded these times by hand for someone who forgot to
   * clock in. Such a row was NOT geofence-verified — clock_in_lat/lng are null.
   */
  manual_entry?: boolean | null;
  manual_entry_by?: string | null;
  manual_entry_at?: string | null;
  manual_entry_reason?: string | null;
  /** 'in' | 'out' | 'both' — which timestamps the manager supplied. */
  manual_entry_fields?: string | null;
  /**
   * Sum of the day's completed clock_sessions — NOT clock_out_at − clock_in_at,
   * which on a split day spans the gap between shifts. Null on rows with no
   * sessions; read it through dayWorkedHours() in lib/utils, never directly.
   */
  worked_hours?: number | null;
  session_count?: number | null;
};

/**
 * One clock-in/clock-out pair. A day can hold several — morning shift, break,
 * evening shift — and clock_events is the per-day header that sums them.
 * See migration 029.
 */
export type ClockSession = {
  id: string;
  clock_event_id: string;
  employee_id: string;
  store_id: string | null;
  /** The date the session STARTED; one crossing midnight stays on its opening day. */
  event_date: string;
  /**
   * 1, 2, 3… INSERTION order within the day — a stable per-day identity, not a
   * chronological one. A manager filling in a forgotten morning shift after the
   * evening one gives it the higher seq. Always sort and derive day bounds by
   * `clock_in_at`.
   */
  seq: number;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  manual_entry: boolean;
  manual_entry_by?: string | null;
  manual_entry_at?: string | null;
  manual_entry_reason?: string | null;
  auto_clocked_out: boolean;
  auto_clock_out_source?: string | null;
  auto_clock_out_at?: string | null;
  /**
   * Drops for THIS shift (migration 033). The day's totals on clock_events are
   * the SUM of these, written only by recomputeDayHeader — before 033 the
   * counts lived on the day header alone and a second clock-out overwrote the
   * first shift's drops.
   */
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
  /**
   * Per-shift sign-off (migration 035). NOTHING on an unapproved shift is paid
   * — not its hours, not its drops. `approved_hours` is the manager's
   * correction for this shift; null means the clocked duration stood.
   */
  hours_approved?: boolean | null;
  approved_hours?: number | string | null;
  hours_approved_by?: string | null;
  hours_approved_at?: string | null;
  created_at: string;
};

/** The part of a session the UI needs to render a day's shifts. */
export type ClockSessionSpan = {
  /** Needed to approve or withdraw THIS shift on its own (migration 035). */
  id?: string;
  seq: number;
  clock_in_at: string;
  clock_out_at: string | null;
  auto_clocked_out?: boolean | null;
  manual_entry?: boolean | null;
  /** Signed off, and so payable, on its own. */
  hours_approved?: boolean | null;
  /** The manager's correction for this shift; null means the clocked time stood. */
  approved_hours?: number | string | null;
  /** This shift's drops — shown so a manager signs off against real figures. */
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
};

/**
 * A manager's clock in/out for a day. Managers are login accounts
 * (allowed_users), not employees, so their attendance lives in its own table
 * keyed on the login account. Monitoring only — never affects the fixed salary.
 */
export type ManagerClockEvent = {
  id: string;
  manager_id: string;
  store_id: string | null;
  event_date: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  created_at: string;
  /** True when the system closed this day because the clock-out was forgotten — see lib/auto-clock-out.ts. */
  auto_clocked_out?: boolean | null;
  /** Where the assumed clock-out time came from: 'rota' | 'store_close' | 'fallback'. */
  auto_clock_out_source?: string | null;
  /**
   * Sum of the day's completed manager_clock_sessions (migration 031). NOT
   * clock_out_at − clock_in_at, which spans the gap between a morning and an
   * evening shift. Null on a pre-031 row — fall back to the raw delta.
   */
  worked_hours?: number | string | null;
  /** How many shifts the day holds. 0 or 1 reads exactly as it always did. */
  session_count?: number | null;
  /**
   * The day's delivery totals — the SUM across its sessions (migration 034),
   * written only by recomputeManagerDayHeader. Null short/long means the day
   * recorded nothing, which is different from a manager answering zero.
   */
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
  /**
   * A manager has confirmed the day's drop counts on Daily Approval — their own
   * day or a peer's. Unlike a cover driver's approval this does NOT gate pay;
   * the drops reach the Tuesday sheet either way, as an employee's do.
   */
  deliveries_approved?: boolean | null;
  /**
   * The day's drops were recorded by hand because the manager never clocked in
   * (migration 037). Such a day has NO clock times and was never location-
   * verified, which is what the "Manual" badge on Daily Approval reports.
   */
  manual_entry?: boolean | null;
  manual_entry_by?: string | null;
  manual_entry_at?: string | null;
  manual_entry_reason?: string | null;
  deliveries_approved_by?: string | null;
  deliveries_approved_at?: string | null;
};

/**
 * One clock-in/clock-out pair inside a manager's day (migration 031). Mirrors
 * ClockSession; manager_clock_events is the per-day header that sums these.
 */
export type ManagerClockSession = {
  id: string;
  clock_event_id: string;
  manager_id: string;
  store_id: string | null;
  /** The date the session STARTED; one crossing midnight stays on its opening day. */
  event_date: string;
  /** INSERTION order within the day, not chronological — sort by clock_in_at. */
  seq: number;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  auto_clocked_out: boolean;
  auto_clock_out_source?: string | null;
  auto_clock_out_at?: string | null;
  /** Drops the manager covered during THIS shift (migration 034). */
  short_deliveries_count?: number | null;
  long_deliveries_count?: number | null;
  extra_short_deliveries?: number | null;
  extra_long_deliveries?: number | null;
  extra_short_reason?: string | null;
  extra_long_reason?: string | null;
  /**
   * Per-shift sign-off (migration 035). Unapproved drops are not paid, and a
   * new shift on an already-approved day arrives unapproved rather than being
   * carried along by the day's flag.
   */
  deliveries_approved?: boolean | null;
  deliveries_approved_by?: string | null;
  deliveries_approved_at?: string | null;
  /**
   * Drops recorded for a day the manager never clocked (migration 037). The row
   * has clock_in_at = clock_out_at, carries no duration, and is excluded from
   * the day's bounds, hours and shift count — only its counts are read.
   */
  deliveries_only?: boolean | null;
  /** Recorded by hand, so never geofence-verified. Mirrors clock_sessions. */
  manual_entry?: boolean | null;
  manual_entry_by?: string | null;
  manual_entry_at?: string | null;
  manual_entry_reason?: string | null;
  created_at: string;
};

/**
 * One manager's day on the Daily Approval screen. Managers are settled on
 * DELIVERIES only — their hours drive no pay — so unlike an employee row there
 * is no hours box to correct here.
 */
export type ManagerDailyApprovalRow = {
  manager_id: string;
  manager_name: string;
  store_id: string | null;
  event_date: string;
  /** Monitoring only; shown so the drops can be read against the shift. */
  worked_hours: number;
  short_deliveries: number;
  long_deliveries: number;
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  extra_short_reason: string | null;
  extra_long_reason: string | null;
  approved: boolean;
  auto_clocked_out: boolean;
  session_count: number;
  /**
   * The day's drops were entered by hand (migration 037). True implies there is
   * no clock record at all for the day — worked_hours reads 0 and no times are
   * shown, because nothing was ever clocked.
   */
  manual_entry: boolean;
  manual_entry_reason: string | null;
};

/**
 * A manager's scheduled shift for a day. Mirrors rota_shifts but keyed on the
 * login account (allowed_users), since managers have no employees row.
 * Scheduling + attendance visibility only — a manager's fixed_daily_wage
 * never depends on this.
 */
export type ManagerShift = {
  id: string;
  manager_id: string;
  store_id: string;
  shift_date: string;
  start_time: string | null;
  end_time: string | null;
  is_day_off: boolean;
  scheduled_hours: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

export type WeeklyDelivery = {
  id: string;
  driver_id: string;
  store_id: string;
  week_start_date: string;
  manager_avg_4wk: number | null;
  vita_mojo_count: number | null;
  notes: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
};

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertType =
  // Wage
  | "wage_variance"
  | "min_wage_violation"
  // Delivery
  | "delivery_payout_high"
  | "delivery_unassigned"
  // Live dashboard
  | "late_clock_in"
  | "unexpected_absence"
  | "early_clock_out"
  // Variance
  | "scheduled_vs_actual"
  // Cash flow (Stage 2)
  | "missing_daily_entry"
  | "unresolved_discrepancy"
  | "post_office_draw"
  | "negative_cash_balance"
  | "wages_not_confirmed"
  | "unconfirmed_payment";

export type SystemAlert = {
  id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  store_id: string | null;
  employee_id: string | null;
  shift_id: string | null;
  title: string;
  message: string;
  payload: Record<string, unknown> | null;
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
};

export type AuditLogEntry = {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  changes: Record<string, unknown> | null;
  created_at: string;
};

/** A failed clock-in/out geofence check — see migrations/014_geofence_failures.sql. */
export type GeofenceFailure = {
  id: string;
  occurred_at: string;
  actor_email: string;
  employee_id: string | null;
  manager_id: string | null;
  action: "clock_in" | "clock_out";
  attempted_lat: number;
  attempted_lng: number;
  accuracy_m: number | null;
  nearest_store_id: string | null;
  nearest_store_name: string | null;
  distance_m: number;
  radius_m: number;
  message: string;
};

/**
 * One browser/device an employee opted into clock-in/out push reminders from.
 * Stores the W3C Push subscription the server needs to reach that device — see
 * migrations/015_push_subscriptions.sql.
 */
export type PushSubscriptionRecord = {
  id: string;
  employee_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
};

export type ReminderType = "clock_in" | "clock_out";

export type EmployeeWeeklySummary = {
  employee_id: string;
  employee_name: string;
  position: EmployeePosition | null;
  store_id: string | null;
  week_start_date: string;
  scheduled_hours: number;
  actual_hours: number;
  deliveries_total: number;
  hourly_ni_rate: number | null;
  hourly_cash_rate: number | null;
  scheduled_ni_wages: number;
  scheduled_cash_wages: number;
  scheduled_total_wages: number;
};

export type SessionUser = {
  id: string;
  email: string;
  allowed: AllowedUser | null;
};

/** Weekly hours computed from clock_events (auto, not manually logged). */
export type ClockWeeklySummary = {
  employee_id: string;
  employee_name: string;
  week_start_date: string;
  total_hours: number;
  event_count: number;
  hourly_ni_rate: number | null;
  hourly_rate: number;
};

// One clocked DAY for an employee, used by the daily hours-approval view.
// clock_events still holds exactly one row per (employee, day), so this maps
// 1:1 — but that day may contain several shifts, carried in `sessions`.
// Approval is per DAY on the total, with the shifts shown for context.
export type ClockDailySummary = {
  employee_id: string;
  employee_name: string;
  event_date: string; // YYYY-MM-DD
  store_id: string | null;
  /** Hours worked across every shift that day (gaps between shifts excluded). */
  clocked_hours: number;
  /** The day's individual shifts, earliest first. Empty on pre-029 rows. */
  sessions: ClockSessionSpan[];
  /** Has a manager approved this day for payroll? */
  hours_approved: boolean;
  /** Manager-confirmed hours (may differ from clocked_hours); null until approved. */
  approved_hours: number | null;
  /**
   * Only a Driver earns a per-delivery petrol allowance, so only a driver's row
   * shows delivery inputs. Derived from `employees.position` via hasRole.
   */
  is_driver: boolean;
  /**
   * The normal round, as entered by the driver at clock-out. A manager can
   * correct these during approval and the corrected figure REPLACES them —
   * there is no separate "approved deliveries" column, because payout, the
   * Rota and Analytics all read these directly and a second precedence rule
   * would have to be honoured identically in each.
   */
  short_deliveries: number;
  long_deliveries: number;
  /**
   * Deliveries beyond the normal round. Read-only here: each carries a written
   * reason, captured through the Rota's DeliveryEditModal. Shown so a manager
   * approves against the full picture of what is being paid.
   */
  extra_short_deliveries: number;
  extra_long_deliveries: number;
  /** Required once its matching extra count is above zero; null otherwise. */
  extra_short_reason: string | null;
  extra_long_reason: string | null;
  /**
   * True when the clock-out was never made and the system assumed the shift
   * end time (see lib/auto-clock-out.ts). The hours are a best estimate, so
   * the approval row flags them for the manager to check.
   */
  auto_clocked_out: boolean;
  /**
   * True when a manager recorded these times by hand (the employee forgot to
   * clock in). The day was not geofence-verified, so it's badged in the
   * approval list rather than blending in with real clock records.
   */
  manual_entry: boolean;
  manual_entry_reason: string | null;
};

export type LiveDashboardStatus =
  | "on_shift"
  | "expected"
  | "clocked_out"
  | "day_off"
  | "tbc"
  | "late"
  | "absent";

// =============================================================
// CASH FLOW MODULE (Stage 2)
// =============================================================

/** One day's envelope reconciliation for a store. */
export type DailyCashEntry = {
  id: string;
  store_id: string;
  entry_date: string;
  vita_mojo_sales: number;
  envelope_amount: number;
  /** Cash spent on supermarket / supplies for the day. */
  supermarket_expenses: number;
  /** Auto-computed: vita_mojo_sales − envelope_amount. +ve = shortfall. */
  difference: number;
  reason: string | null;
  is_late: boolean;
  submitted_by: string | null;
  submitted_by_name: string | null;
  submitted_by_email: string | null;
  edited_by_name: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DailyCashEntryWithStore = DailyCashEntry & {
  store_name: string | null;
};

export type CashPayoutStatus = "draft" | "confirmed";

/** Weekly payout header (one per store per week). */
export type CashPayout = {
  id: string;
  store_id: string;
  week_start_date: string;
  payment_date: string | null;
  status: CashPayoutStatus;
  opening_balance: number;
  cash_collected: number;
  logged_differences: number;
  actual_cash_available: number;
  total_cash_wages: number;
  total_delivery_wages: number;
  grand_total_wages: number;
  /**
   * Manual cash adjustment (migration 039), SIGNED: positive = cash added to
   * the pot, negative = taken out. Applied at the settle, NOT inside
   * actual_cash_available — see buildPrePaymentSummary.
   */
  adjustment_amount: number;
  adjustment_reason: string | null;
  post_office_draw: number;
  surplus_carry_forward: number;
  locked: boolean;
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Per-employee line within a weekly payout. */
export type CashPayoutLine = {
  id: string;
  payout_id: string;
  /** Null on a cover driver or manager line — see the two ids below. */
  employee_id: string | null;
  /** Set instead of employee_id when this line pays a cover driver (migration 027). */
  cover_driver_id?: string | null;
  /** Set instead of the other two when this line pays a manager for deliveries
   *  they covered (migration 034). Deliveries only — never their salary. */
  manager_id?: string | null;
  employee_name: string;
  role: string | null;
  cash_hours: number;
  cash_rate: number;
  cash_wage: number;
  /** Rounds delivered on the normal run (excludes the misc/extra counts). */
  short_deliveries_count: number;
  long_deliveries_count: number;
  /** Extra ("miscellaneous") drops beyond the normal round. */
  short_misc_count: number;
  long_misc_count: number;
  short_delivery_rate: number;
  long_delivery_rate: number;
  /**
   * The rate each MISC drop was priced at, snapshotted so a later rate change
   * can't restate a paid week (migration 040). Null = the base rate above was
   * used, which is every line written before 040 and every non-manager line.
   */
  short_misc_rate: number | null;
  long_misc_rate: number | null;
  delivery_wages: number;
  total_payment: number;
  is_paid: boolean;
  paid_at: string | null;
  paid_by_name: string | null;
  created_at: string;
  updated_at: string;
};

export type CashPayoutWithLines = CashPayout & {
  lines: CashPayoutLine[];
  store_name: string | null;
};

/**
 * A computed wage line for an employee for a week (before persistence). Shape
 * mirrors CashPayoutLine's wage fields so the live preview and saved sheet
 * render identically.
 */
export type WageLine = {
  /**
   * The employees.id being paid, or "" for a cover driver line — cover drivers
   * are not employees rows, so they carry cover_driver_id instead. Exactly one
   * of the two identifies the payee (enforced by a check constraint on
   * cash_payout_lines, migration 027).
   */
  employee_id: string;
  /** Set instead of employee_id when this line pays a cover driver. */
  cover_driver_id?: string | null;
  /**
   * Set instead of the other two when this line pays a MANAGER for deliveries
   * they covered (migration 034). Deliveries only: cash_hours and cash_wage are
   * always zero, because a manager's fixed daily wage never flows through here.
   */
  manager_id?: string | null;
  /** True for a cover driver line — drives the "Cover" badge on the sheet. */
  is_cover_driver?: boolean;
  /** True for a manager line — drives the "Manager" badge on the sheet. */
  is_manager?: boolean;
  employee_name: string;
  role: string | null;
  cash_hours: number;
  cash_rate: number;
  cash_wage: number;
  /** Rounds delivered on the normal run (excludes the misc/extra counts). */
  short_deliveries_count: number;
  long_deliveries_count: number;
  /** Extra ("miscellaneous") drops beyond the normal round. */
  short_misc_count: number;
  long_misc_count: number;
  short_delivery_rate: number;
  long_delivery_rate: number;
  /**
   * The rate the MISC drops were priced at (migration 040). Only a manager line
   * can differ from the base rate; everyone else leaves these null, meaning
   * "same as short_delivery_rate / long_delivery_rate".
   */
  short_misc_rate?: number | null;
  long_misc_rate?: number | null;
  delivery_wages: number;
  total_payment: number;
};

/** The Tuesday pre-payment summary (§3.4 of the spec). */
export type PrePaymentSummary = {
  store_id: string;
  week_start_date: string;
  opening_balance: number;
  vita_mojo_total: number;
  cash_collected: number;
  logged_differences: number;
  /** Default supermarket cash float added to the pot (from app settings). */
  supermarket_cash: number;
  actual_cash_available: number;
  total_cash_wages: number;
  total_delivery_wages: number;
  grand_total_wages: number;
  /**
   * Manual cash adjustment for this store-week (migration 039), SIGNED.
   * Deliberately outside actual_cash_available — it settles one step later, so
   * the cash reconciliation above it stays a record of real till movements.
   */
  adjustment: number;
  adjustment_reason: string | null;
  /** grand_total_wages − (actual_cash_available + adjustment), clamped ≥ 0. */
  post_office_draw: number;
  /** (actual_cash_available + adjustment) − grand_total_wages, clamped ≥ 0. */
  surplus: number;
  lines: WageLine[];
  /**
   * Set when a query behind these figures failed. The totals are then NOT
   * trustworthy — an empty result from a broken query looks exactly like a week
   * nobody worked, so the screen must say so rather than show a confident £0.
   */
  load_error?: string | null;
};
