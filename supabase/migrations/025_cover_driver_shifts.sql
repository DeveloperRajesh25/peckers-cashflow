-- =============================================================
-- Migration 025 — Cover driver rota shifts (per-date) + auto clock-out columns
--
-- Run AFTER 023_cover_drivers.sql and 024_cover_driver_schedules.sql.
--
-- Two tables, two different jobs — same split employees already have:
--   * cover_driver_schedules (024) = the RECURRING weekly pattern. "Usually
--     available Sat + Sun." Changing it changes every week.
--   * cover_driver_shifts    (this) = a SPECIFIC DATE. "This Saturday, 5pm–11pm"
--     or "off this weekend." Overrides the pattern for that one day.
--
-- Mirrors manager_shifts rather than rota_shifts: like managers, a cover driver
-- is not an `employees` row, so it keys on its own parent table.
--
-- NOTE: `scheduled_hours` here drives the Live board's EXPECTED wage only.
-- Actual pay still comes from cover_driver_hours, approved off real clock
-- events — a rota cell can never pay anyone.
-- =============================================================

create table if not exists public.cover_driver_shifts (
  id              uuid primary key default gen_random_uuid(),
  cover_driver_id uuid not null references public.cover_drivers(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  shift_date      date not null,
  start_time      time,
  end_time        time,
  is_day_off      boolean not null default false,
  scheduled_hours numeric(5,2) not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null
);

create unique index if not exists cover_driver_shifts_unique
  on public.cover_driver_shifts (cover_driver_id, shift_date);
create index if not exists cover_driver_shifts_date_idx
  on public.cover_driver_shifts (shift_date);
create index if not exists cover_driver_shifts_store_date_idx
  on public.cover_driver_shifts (store_id, shift_date);

drop trigger if exists set_cover_driver_shifts_updated_at on public.cover_driver_shifts;
create trigger set_cover_driver_shifts_updated_at
  before update on public.cover_driver_shifts
  for each row execute function public.set_updated_at();

alter table public.cover_driver_shifts enable row level security;

drop policy if exists "cover_driver_shifts_select" on public.cover_driver_shifts;
drop policy if exists "cover_driver_shifts_modify" on public.cover_driver_shifts;

-- Unlike manager_shifts (admin-only), managers MAY edit cover driver shifts for
-- their own store: managers already create cover drivers and approve their
-- hours, so locking them out of the rota cell would be inconsistent.
-- can_access_store honours a manager's ACTIVE store (migration 020).
create policy "cover_driver_shifts_select" on public.cover_driver_shifts
  for select to authenticated
  using (
    cover_driver_id = public.current_cover_driver_id()
    or public.can_access_store(store_id)
  );

create policy "cover_driver_shifts_modify" on public.cover_driver_shifts
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

grant select, insert, update, delete on public.cover_driver_shifts to authenticated;

-- ---- Auto clock-out columns on cover_driver_clock_events ----
-- Every hours calculation needs BOTH timestamps, so a forgotten clock-out
-- doesn't lose the tail of a shift — it erases the whole day (0.00h, never
-- reaches the approval queue) and leaves the driver showing "On Shift" on the
-- Live board indefinitely. These mirror clock_events so the same nightly sweep
-- (lib/auto-clock-out.ts) can close cover driver days too, flagged so a manager
-- can see the end time was assumed.
alter table public.cover_driver_clock_events
  add column if not exists auto_clocked_out       boolean not null default false,
  add column if not exists auto_clock_out_source  text,
  add column if not exists auto_clock_out_at      timestamptz;
