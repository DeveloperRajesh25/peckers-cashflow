-- =============================================================
-- Migration 034 — Manager deliveries, and drops recorded at manual entry
--
-- Run AFTER 033. ADDITIVE ONLY — no column is dropped, no existing value is
-- changed, and the one constraint that is replaced is WIDENED, never narrowed.
-- So this is safe to run BEFORE the new code ships (the rule migration 027
-- nearly broke; see Update 65).
--
-- TWO PROBLEMS, ONE SHAPE
--
-- 1. A manager recording a missed clock-in could enter times but no drops.
--    Nothing here is needed for that — clock_sessions already carries the four
--    counts (migration 033) and cover_driver_clock_events has carried them
--    since 023. The gap was purely in the UI and the two server actions.
--
-- 2. A manager who covers deliveries on a busy night had nowhere to record
--    them, so that money never reached the Tuesday sheet. Managers are login
--    accounts (allowed_users), not employees, so they need their own rates and
--    their own payout line.
--
-- The manager half deliberately mirrors what employees already do, one table
-- over: each SHIFT records its own counts on manager_clock_sessions, and
-- manager_clock_events becomes a derived SUM written solely by
-- recomputeManagerDayHeader (lib/manager-clock-sessions.ts). Identical to the
-- 029/033 pattern, so the two halves cannot drift on what a split day totals.
--
-- Manager pay is UNCHANGED: their fixed daily wage still never flows through
-- this app. The payout line a manager can now receive pays DELIVERIES ONLY.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- 1. allowed_users — per-manager delivery rates
--
-- Null means "not set", and the app falls back to DELIVERY_PETROL_RATE exactly
-- as it already does for an employee with no rate on file. Deliberately NOT
-- defaulted to 2 here: a null rate is how the Managers page knows to show
-- "default" rather than implying someone chose that number.
-- =============================================================
alter table public.allowed_users
  add column if not exists short_delivery_rate numeric(8,2),
  add column if not exists long_delivery_rate  numeric(8,2);

comment on column public.allowed_users.short_delivery_rate is
  'Per-drop rate (£) for a manager''s SHORT deliveries. Null = fall back to the default petrol rate. Only meaningful for role=manager.';
comment on column public.allowed_users.long_delivery_rate is
  'Per-drop rate (£) for a manager''s LONG deliveries. Null = fall back to the default petrol rate. Only meaningful for role=manager.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'allowed_users_delivery_rates_non_negative'
  ) then
    alter table public.allowed_users
      add constraint allowed_users_delivery_rates_non_negative
      check (
        coalesce(short_delivery_rate, 0) >= 0
        and coalesce(long_delivery_rate, 0) >= 0
      );
  end if;
end $$;

-- =============================================================
-- 2. manager_clock_sessions — each shift carries its own delivery counts
--
-- Same columns, same nullability rules and same reason as migration 033 gave
-- clock_sessions: null (not 0) means "this shift recorded nothing", which is a
-- different thing from a manager explicitly answering zero.
-- =============================================================
alter table public.manager_clock_sessions
  add column if not exists short_deliveries_count integer,
  add column if not exists long_deliveries_count  integer,
  add column if not exists extra_short_deliveries integer not null default 0,
  add column if not exists extra_long_deliveries  integer not null default 0,
  add column if not exists extra_short_reason     text,
  add column if not exists extra_long_reason      text;

comment on column public.manager_clock_sessions.short_deliveries_count is
  'Short drops the manager did during THIS shift. manager_clock_events.short_deliveries_count is the day''s SUM of these, written only by recomputeManagerDayHeader.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'manager_clock_sessions_deliveries_non_negative'
  ) then
    alter table public.manager_clock_sessions
      add constraint manager_clock_sessions_deliveries_non_negative
      check (
        coalesce(short_deliveries_count, 0) >= 0
        and coalesce(long_deliveries_count, 0) >= 0
        and extra_short_deliveries >= 0
        and extra_long_deliveries >= 0
      );
  end if;
end $$;

-- =============================================================
-- 3. manager_clock_events — the day's totals, plus its approval
--
-- The counts are a derived SUM of the day's sessions. The approval columns
-- mirror clock_events.hours_approved (migration 016) in name and meaning, with
-- one difference that matters: a manager's drops REACH THE PAYOUT WHETHER OR
-- NOT the day is approved, exactly as an employee's hours do. Approval refines
-- the numbers and records who signed them off; it does not gate the money.
-- (Cover drivers are the opposite — approval gates their pay entirely.)
-- =============================================================
alter table public.manager_clock_events
  add column if not exists short_deliveries_count integer,
  add column if not exists long_deliveries_count  integer,
  add column if not exists extra_short_deliveries integer not null default 0,
  add column if not exists extra_long_deliveries  integer not null default 0,
  add column if not exists extra_short_reason     text,
  add column if not exists extra_long_reason      text,
  add column if not exists deliveries_approved    boolean not null default false,
  add column if not exists deliveries_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists deliveries_approved_at timestamptz;

comment on column public.manager_clock_events.short_deliveries_count is
  'The DAY''s short drops — the SUM across its manager_clock_sessions. Written only by recomputeManagerDayHeader.';
comment on column public.manager_clock_events.deliveries_approved is
  'A manager (their own day or a peer''s — deliberate, managers are trusted) has confirmed this day''s drop counts. Does NOT gate payment.';

create index if not exists manager_clock_events_deliveries_pending_idx
  on public.manager_clock_events (event_date desc)
  where not deliveries_approved
    and (coalesce(short_deliveries_count, 0) > 0 or coalesce(long_deliveries_count, 0) > 0
         or extra_short_deliveries > 0 or extra_long_deliveries > 0);

-- =============================================================
-- 4. RLS — a manager can approve a PEER's drops at the store they run
--
-- 012/031 scoped both tables to `manager_id = current_allowed_user_id()`: a
-- manager could only ever see and touch their OWN rows. That is now too tight
-- in two places:
--   * Daily Approval must list every manager who worked that day at the store;
--   * the Tuesday payout must read their drops to build the wage line.
-- Both run under the caller's session, so RLS is what decides.
--
-- Widened to can_access_store(store_id) — the same helper the cash module and
-- the cover driver tables already use, which honours a manager's ACTIVE store
-- (migration 020) and passes admins through. The own-row clause is KEPT beside
-- it, because a legacy row can have a null store_id and must stay reachable by
-- the person it belongs to.
--
-- INSERT stays own-row only: recording someone else's clock-in is the manual
-- entry path's job, not something a peer should do silently.
-- =============================================================
drop policy if exists "manager_clock_select" on public.manager_clock_events;
drop policy if exists "manager_clock_update" on public.manager_clock_events;

create policy "manager_clock_select" on public.manager_clock_events
  for select to authenticated
  using (
    public.is_admin(auth.jwt() ->> 'email')
    or manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  );

create policy "manager_clock_update" on public.manager_clock_events
  for update to authenticated
  using (
    manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  )
  with check (
    manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  );

drop policy if exists "manager_clock_sessions_select" on public.manager_clock_sessions;
drop policy if exists "manager_clock_sessions_update" on public.manager_clock_sessions;

create policy "manager_clock_sessions_select" on public.manager_clock_sessions
  for select to authenticated
  using (
    public.is_admin(auth.jwt() ->> 'email')
    or manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  );

create policy "manager_clock_sessions_update" on public.manager_clock_sessions
  for update to authenticated
  using (
    manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  )
  with check (
    manager_id = public.current_allowed_user_id()
    or public.can_access_store(store_id)
  );

-- =============================================================
-- 5. cash_payout_lines — a line can now pay a MANAGER
--
-- Third payee type, same table, same reason migration 027 gave for cover
-- drivers: the sheet, its totals, the paid tick and the history view all keep
-- working with no second code path.
-- =============================================================
alter table public.cash_payout_lines
  add column if not exists manager_id uuid
    references public.allowed_users(id) on delete set null;

comment on column public.cash_payout_lines.manager_id is
  'Set instead of employee_id/cover_driver_id when this line pays a manager for deliveries they covered. Exactly one of the three is non-null. A manager line is deliveries-only — their fixed daily wage never flows through the payout.';

-- Deduplicated by its own partial index, exactly like the cover driver one.
-- The original cash_payout_lines_unique (payout_id, employee_id) is untouched;
-- manager lines have employee_id null and Postgres treats nulls as distinct,
-- so they cannot collide with it.
create unique index if not exists cash_payout_lines_manager_unique
  on public.cash_payout_lines (payout_id, manager_id)
  where manager_id is not null;

-- Exactly one payee of the three. This REPLACES the two-way constraint from
-- 027 — a widening, so every row that satisfied the old rule satisfies this
-- one, and no currently deployed write can start failing when it runs.
--
-- Left NOT VALID for the same reason 027 was: employee_id is
-- `on delete set null`, so deleting an employee leaves historical lines with
-- all three null — real, already-paid records that must not block a migration.
-- NOT VALID still enforces the rule on every future insert and update.
alter table public.cash_payout_lines
  drop constraint if exists cash_payout_lines_one_payee;
alter table public.cash_payout_lines
  add constraint cash_payout_lines_one_payee
  check (
    (employee_id is not null and cover_driver_id is null and manager_id is null)
    or (employee_id is null and cover_driver_id is not null and manager_id is null)
    or (employee_id is null and cover_driver_id is null and manager_id is not null)
  ) not valid;

-- =============================================================
-- Backfill: none, deliberately.
--
-- Every manager day on record predates managers being able to log a drop, so
-- their counts are genuinely null/zero — there is nothing to carry forward, and
-- no historical payout total moves by a penny when this runs.
-- =============================================================
