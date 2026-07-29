-- =============================================================
-- Migration 024 — Cover driver weekly schedules
--
-- Run AFTER 023_cover_drivers.sql (this references cover_drivers).
--
-- Mirrors `employee_schedules`: the recurring weekly availability pattern, one
-- row per weekday (0=Mon .. 6=Sun). Its own table rather than reusing
-- employee_schedules, whose employee_id is foreign-keyed to `employees` —
-- pointing it at a cover driver would mean either dropping that FK or creating
-- fake `employees` rows, and a fake employees row is exactly what leaks a cover
-- driver into the rota, payout sheet and NI report.
--
-- IMPORTANT: unlike employee_schedules this is availability ONLY. It is never
-- read by applyScheduleToWeek and never generates shifts of any kind. It tells
-- a manager which days a driver can usually cover, which pre-fills their cells
-- on the Rota; the actual booking is a cover_driver_shifts row (migration 025).
-- =============================================================

create table if not exists public.cover_driver_schedules (
  id              uuid primary key default gen_random_uuid(),
  cover_driver_id uuid not null references public.cover_drivers(id) on delete cascade,
  weekday         smallint not null check (weekday between 0 and 6),
  is_working      boolean not null default true,
  start_time      time,
  end_time        time,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  unique (cover_driver_id, weekday)
);

create index if not exists cover_driver_schedules_driver_idx
  on public.cover_driver_schedules (cover_driver_id);

drop trigger if exists set_cover_driver_schedules_updated_at
  on public.cover_driver_schedules;
create trigger set_cover_driver_schedules_updated_at
  before update on public.cover_driver_schedules
  for each row execute function public.set_updated_at();

alter table public.cover_driver_schedules enable row level security;

drop policy if exists "cover_driver_schedules_select" on public.cover_driver_schedules;
drop policy if exists "cover_driver_schedules_modify" on public.cover_driver_schedules;

-- Store scoping comes from the parent driver, since this table has no store_id
-- of its own — a manager may only touch schedules for drivers at the store they
-- are currently managing (can_access_store honours the ACTIVE store, migration 020).
create policy "cover_driver_schedules_select" on public.cover_driver_schedules
  for select to authenticated
  using (
    cover_driver_id = public.current_cover_driver_id()
    or exists (
      select 1 from public.cover_drivers d
      where d.id = cover_driver_id and public.can_access_store(d.store_id)
    )
  );

create policy "cover_driver_schedules_modify" on public.cover_driver_schedules
  for all to authenticated
  using (
    exists (
      select 1 from public.cover_drivers d
      where d.id = cover_driver_id and public.can_access_store(d.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.cover_drivers d
      where d.id = cover_driver_id and public.can_access_store(d.store_id)
    )
  );

grant select, insert, update, delete on public.cover_driver_schedules to authenticated;
