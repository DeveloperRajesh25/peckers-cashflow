-- =============================================================
-- Migration 023 — Cover drivers (self-service, clock-based)
--
-- Must run AFTER 020_manager_active_store: the RLS below calls
-- can_access_store(), which 020 redefines to honour a manager's ACTIVE store.
-- Running this first would scope a switched manager to the wrong store.
--
-- Cover drivers are part-time drivers hired ad-hoc. They are deliberately NOT
-- rows in `employees`: ~20 files query that table (rota, live, payouts, NI,
-- analytics, alerts) and a cover driver must appear in NONE of them. Keeping
-- them in their own tables means those files need no filtering and cannot leak.
--
-- Differences from employees, by design:
--   * CASH ONLY — no NI rate, no 20h bank/cash split. Every hour is cash.
--   * No rota. Clock-in never writes rota_shifts.
--   * Approvals are per DAY, not per ISO week.
--   * Pay = hours * hourly_cash_rate + deliveries * their per-type rate.
--
-- Replaces migration 007's `cover_driver_records` (manager typed hours by hand).
-- Legacy rows are backfilled below; see step 8 for dropping the old table.
--
-- Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- ---- 1. Cover driver profile ----
create table if not exists public.cover_drivers (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  name                 text not null,
  phone                text,
  date_of_birth        date,
  -- Cash-only pay. There is intentionally no hourly_ni_rate here.
  hourly_cash_rate     numeric(8,2) not null,
  short_delivery_rate  numeric(8,2),
  long_delivery_rate   numeric(8,2),
  -- Login linkage, written once by provisioning. Never edited by the profile form.
  email                text,
  auth_user_id         uuid references auth.users(id) on delete set null,
  is_active            boolean not null default true,
  notes                text,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);

create unique index if not exists cover_drivers_email_unique
  on public.cover_drivers (lower(email)) where email is not null;
create index if not exists cover_drivers_store_idx on public.cover_drivers (store_id);
create index if not exists cover_drivers_active_idx on public.cover_drivers (is_active);

-- ---- 2. Clock events ----
-- Mirrors clock_events minus shift_id: cover drivers are not on the rota.
create table if not exists public.cover_driver_clock_events (
  id                     uuid primary key default gen_random_uuid(),
  cover_driver_id        uuid not null references public.cover_drivers(id) on delete cascade,
  store_id               uuid not null references public.stores(id) on delete cascade,
  event_date             date not null,
  clock_in_at            timestamptz,
  clock_out_at           timestamptz,
  clock_in_lat           numeric(10,7),
  clock_in_lng           numeric(10,7),
  clock_out_lat          numeric(10,7),
  clock_out_lng          numeric(10,7),
  short_deliveries_count integer,
  long_deliveries_count  integer,
  extra_short_deliveries integer not null default 0,
  extra_long_deliveries  integer not null default 0,
  extra_short_reason     text,
  extra_long_reason      text,
  created_at             timestamptz not null default now()
);

create unique index if not exists cover_driver_clock_unique
  on public.cover_driver_clock_events (cover_driver_id, event_date);
create index if not exists cover_driver_clock_store_date_idx
  on public.cover_driver_clock_events (store_id, event_date desc);

-- ---- 3. Approved hours, keyed by DATE (employees are keyed by week) ----
-- Rates and delivery counts are SNAPSHOT at approval so historic pay can never
-- drift when a driver's rate is later changed.
create table if not exists public.cover_driver_hours (
  id                    uuid primary key default gen_random_uuid(),
  cover_driver_id       uuid not null references public.cover_drivers(id) on delete cascade,
  store_id              uuid not null references public.stores(id) on delete cascade,
  work_date             date not null,
  total_hours_worked    numeric(6,2) not null,
  hourly_rate_snapshot  numeric(8,2) not null,
  short_deliveries      integer not null default 0,
  long_deliveries       integer not null default 0,
  short_rate_snapshot   numeric(8,2),
  long_rate_snapshot    numeric(8,2),
  notes                 text,
  approved              boolean not null default false,
  approved_by           uuid references auth.users(id) on delete set null,
  approved_at           timestamptz,
  source                text not null default 'clocked' check (source in ('clocked','manual')),
  created_at            timestamptz not null default now()
);

create unique index if not exists cover_driver_hours_unique
  on public.cover_driver_hours (cover_driver_id, work_date);
create index if not exists cover_driver_hours_date_idx
  on public.cover_driver_hours (work_date desc);

-- ---- 4. Computed view ----
-- security_invoker: must respect the CALLER's RLS, or an owner-rights view
-- would expose every store's pay to any authenticated user.
drop view if exists public.cover_driver_hours_computed;
create view public.cover_driver_hours_computed with (security_invoker = true) as
select
  h.id,
  h.cover_driver_id,
  d.name                                                   as driver_name,
  h.store_id,
  h.work_date,
  h.total_hours_worked,
  h.hourly_rate_snapshot,
  h.short_deliveries,
  h.long_deliveries,
  h.short_rate_snapshot,
  h.long_rate_snapshot,
  -- Cash only: no bank split, every hour is paid cash.
  h.total_hours_worked * h.hourly_rate_snapshot            as hours_pay,
  h.short_deliveries * coalesce(h.short_rate_snapshot, 0)  as short_delivery_pay,
  h.long_deliveries  * coalesce(h.long_rate_snapshot, 0)   as long_delivery_pay,
  h.total_hours_worked * h.hourly_rate_snapshot
    + h.short_deliveries * coalesce(h.short_rate_snapshot, 0)
    + h.long_deliveries  * coalesce(h.long_rate_snapshot, 0) as total_pay,
  h.notes,
  h.approved,
  h.approved_at,
  h.source,
  h.created_at
from public.cover_driver_hours h
join public.cover_drivers d on d.id = h.cover_driver_id;

-- ---- 5. Login accounts ----
alter table public.allowed_users
  add column if not exists cover_driver_id uuid references public.cover_drivers(id) on delete cascade;

alter table public.allowed_users drop constraint if exists allowed_users_role_check;
alter table public.allowed_users add constraint allowed_users_role_check
  check (role in ('admin','manager','employee','cover_driver'));

-- The cover_drivers.id linked to the current login. Mirrors current_employee_id().
-- NOTE: is_staff() stays ('admin','manager'), so a cover_driver login is not
-- staff and every existing staff-gated policy already excludes it unchanged.
create or replace function public.current_cover_driver_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select cover_driver_id from public.allowed_users
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

-- ---- 6. RLS ----
alter table public.cover_drivers             enable row level security;
alter table public.cover_driver_clock_events enable row level security;
alter table public.cover_driver_hours        enable row level security;

drop policy if exists "cover_drivers_select"       on public.cover_drivers;
drop policy if exists "cover_drivers_modify"       on public.cover_drivers;
drop policy if exists "cover_driver_clock_select"  on public.cover_driver_clock_events;
drop policy if exists "cover_driver_clock_insert"  on public.cover_driver_clock_events;
drop policy if exists "cover_driver_clock_update"  on public.cover_driver_clock_events;
drop policy if exists "cover_driver_clock_delete"  on public.cover_driver_clock_events;
drop policy if exists "cover_driver_hours_select"  on public.cover_driver_hours;
drop policy if exists "cover_driver_hours_modify"  on public.cover_driver_hours;

-- Staff see their store's drivers (admins all); a cover driver sees only itself.
create policy "cover_drivers_select" on public.cover_drivers
  for select to authenticated
  using (public.can_access_store(store_id) or id = public.current_cover_driver_id());

create policy "cover_drivers_modify" on public.cover_drivers
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

create policy "cover_driver_clock_select" on public.cover_driver_clock_events
  for select to authenticated
  using (
    public.can_access_store(store_id)
    or cover_driver_id = public.current_cover_driver_id()
  );

create policy "cover_driver_clock_insert" on public.cover_driver_clock_events
  for insert to authenticated
  with check (
    public.can_access_store(store_id)
    or cover_driver_id = public.current_cover_driver_id()
  );

create policy "cover_driver_clock_update" on public.cover_driver_clock_events
  for update to authenticated
  using (
    public.can_access_store(store_id)
    or cover_driver_id = public.current_cover_driver_id()
  )
  with check (
    public.can_access_store(store_id)
    or cover_driver_id = public.current_cover_driver_id()
  );

create policy "cover_driver_clock_delete" on public.cover_driver_clock_events
  for delete to authenticated
  using (public.can_access_store(store_id));

-- Approved pay is staff-managed; a driver may read their own rows only.
create policy "cover_driver_hours_select" on public.cover_driver_hours
  for select to authenticated
  using (
    public.can_access_store(store_id)
    or cover_driver_id = public.current_cover_driver_id()
  );

create policy "cover_driver_hours_modify" on public.cover_driver_hours
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

grant select, insert, update, delete on public.cover_drivers             to authenticated;
grant select, insert, update, delete on public.cover_driver_clock_events to authenticated;
grant select, insert, update, delete on public.cover_driver_hours        to authenticated;
grant select on public.cover_driver_hours_computed to authenticated;

-- ---- 7. Backfill from the legacy cover_driver_records table ----
-- One cover_drivers row per (store, name), rate taken from that driver's most
-- recent record. is_active = false and email = null: they have no login until
-- an admin re-provisions them, which is deliberate.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'cover_driver_records'
  ) then

    -- `where not exists` rather than `on conflict`: (store_id, name) has no
    -- unique constraint (two real people may share a name), so this is what
    -- makes a re-run of the migration safe.
    insert into public.cover_drivers (store_id, name, hourly_cash_rate, is_active, notes)
    select distinct on (r.store_id, lower(btrim(r.driver_name)))
           r.store_id,
           btrim(r.driver_name),
           r.hourly_rate,
           false,
           'Migrated from manual cover driver records (migration 023).'
    from public.cover_driver_records r
    where btrim(coalesce(r.driver_name, '')) <> ''
      and not exists (
        select 1 from public.cover_drivers d
        where d.store_id = r.store_id
          and lower(d.name) = lower(btrim(r.driver_name))
      )
    order by r.store_id, lower(btrim(r.driver_name)), r.work_date desc, r.created_at desc;

    insert into public.cover_driver_hours (
      cover_driver_id, store_id, work_date, total_hours_worked,
      hourly_rate_snapshot, approved, approved_at, source, notes, created_at
    )
    select d.id,
           r.store_id,
           r.work_date,
           r.hours_worked,
           r.hourly_rate,
           true,
           r.created_at,
           'manual',
           'Migrated from manual cover driver records (migration 023).',
           r.created_at
    from public.cover_driver_records r
    join public.cover_drivers d
      on d.store_id = r.store_id
     and lower(d.name) = lower(btrim(r.driver_name))
    on conflict (cover_driver_id, work_date) do nothing;

  end if;
end $$;

-- ---- 8. Drop the legacy table ----
-- Left commented on purpose. Run steps 1–7, confirm the Cover Drivers table on
-- /employees shows every migrated row, THEN run this line on its own.
--
--   drop table if exists public.cover_driver_records;
