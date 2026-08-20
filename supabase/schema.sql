-- =============================================================
-- PECKERS CASH FLOW MANAGEMENT SYSTEM
-- Complete database schema for Supabase
-- Run this entire file in the Supabase SQL Editor.
-- =============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";

-- =============================================================
-- TABLE: allowed_users
-- Whitelist of emails permitted to log in.
-- =============================================================
create table if not exists public.allowed_users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text,
  role        text not null default 'manager' check (role in ('admin','manager')),
  created_at  timestamptz not null default now()
);

create index if not exists allowed_users_email_idx on public.allowed_users (email);

-- =============================================================
-- TABLE: cash_entries
-- Daily cash sales and supermarket expenses logged by managers.
-- =============================================================
create table if not exists public.cash_entries (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references auth.users(id) on delete set null,
  user_email            text,
  entry_date            date not null,
  cash_sales            numeric(10,2) not null default 0,
  supermarket_expenses  numeric(10,2) not null default 0,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- For deployments that already had cash_entries, ensure column exists.
alter table public.cash_entries
  add column if not exists user_email text;

-- One entry per user per day (upsert behaviour from app)
create unique index if not exists cash_entries_user_day_unique
  on public.cash_entries (user_id, entry_date);

create index if not exists cash_entries_date_idx on public.cash_entries (entry_date desc);

-- Trigger to keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_cash_entries_updated_at on public.cash_entries;
create trigger set_cash_entries_updated_at
  before update on public.cash_entries
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: employees
-- =============================================================
create table if not exists public.employees (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  phone                     text,
  hourly_rate               numeric(8,2) not null,
  bank_weekly_hours_limit   integer not null default 20,
  is_active                 boolean not null default true,
  joined_date               date,
  notes                     text,
  created_at                timestamptz not null default now()
);

create index if not exists employees_active_idx on public.employees (is_active);

-- =============================================================
-- TABLE: employee_hours
-- Weekly hours per employee. Computed columns are calculated in
-- the app layer and surfaced via the view below.
-- =============================================================
create table if not exists public.employee_hours (
  id                     uuid primary key default gen_random_uuid(),
  employee_id            uuid not null references public.employees(id) on delete cascade,
  week_start_date        date not null,
  total_hours_worked     numeric(5,2) not null,
  hourly_rate_snapshot   numeric(8,2) not null,
  notes                  text,
  logged_by              uuid references auth.users(id) on delete set null,
  -- Manager approval of clocked hours (see migration 002).
  approved               boolean not null default false,
  approved_by            uuid references auth.users(id) on delete set null,
  approved_at            timestamptz,
  source                 text not null default 'manual'
                           check (source in ('manual', 'clocked')),
  created_at             timestamptz not null default now()
);

create unique index if not exists employee_hours_unique
  on public.employee_hours (employee_id, week_start_date);

create index if not exists employee_hours_week_idx on public.employee_hours (week_start_date desc);

-- =============================================================
-- VIEW: employee_hours_computed
-- Adds bank_hours, cash_hours, cash_amount_due.
-- (Dropped first so re-runs can change the column set/order.)
-- security_invoker: the view must respect the CALLER's RLS — owner-rights
-- views bypass employee_hours/employees policies for every authenticated user.
-- =============================================================
drop view if exists public.employee_hours_computed;
create view public.employee_hours_computed with (security_invoker = true) as
select
  eh.id,
  eh.employee_id,
  e.name                                         as employee_name,
  e.phone                                        as employee_phone,
  eh.week_start_date,
  eh.total_hours_worked,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then least(eh.total_hours_worked, coalesce(e.bank_weekly_hours_limit, 20))
    else eh.total_hours_worked
  end                                             as bank_hours,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then greatest(eh.total_hours_worked - coalesce(e.bank_weekly_hours_limit, 20), 0)
    else 0
  end                                             as cash_hours,
  case
    when e.hourly_cash_rate is not null and e.hourly_cash_rate > 0
      then greatest(eh.total_hours_worked - coalesce(e.bank_weekly_hours_limit, 20), 0)
        * e.hourly_cash_rate
    else 0
  end                                             as cash_amount_due,
  eh.hourly_rate_snapshot,
  eh.notes,
  eh.logged_by,
  eh.approved,
  eh.approved_at,
  eh.source,
  eh.created_at
from public.employee_hours eh
join public.employees e on e.id = eh.employee_id;

-- =============================================================
-- HELPER: is_allowed(email)
-- =============================================================
create or replace function public.is_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users
    where lower(email) = lower(p_email)
  );
$$;

create or replace function public.is_admin(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users
    where lower(email) = lower(p_email) and role = 'admin'
  );
$$;

-- =============================================================
-- ACCOUNT-LINK COLUMNS + ROLE HELPERS
-- Declared here (before RLS) because the policies below depend on them.
-- The Stage 1 extension section re-declares these columns idempotently.
-- =============================================================
alter table public.employees
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table public.allowed_users
  add column if not exists employee_id uuid references public.employees(id) on delete cascade;

-- Role of the currently-authenticated user, by JWT email.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.allowed_users
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

-- True for admin OR manager (staff who manage data).
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_role() in ('admin','manager');
$$;

-- The employees.id linked to the current login account (employee portal).
create or replace function public.current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select employee_id from public.allowed_users
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
alter table public.allowed_users  enable row level security;
alter table public.cash_entries   enable row level security;
alter table public.employees      enable row level security;
alter table public.employee_hours enable row level security;

-- Drop existing policies to keep this file rerunnable
drop policy if exists "allowed_users_select"        on public.allowed_users;
drop policy if exists "allowed_users_admin_modify"  on public.allowed_users;
drop policy if exists "cash_entries_select"         on public.cash_entries;
drop policy if exists "cash_entries_insert"         on public.cash_entries;
drop policy if exists "cash_entries_update"         on public.cash_entries;
drop policy if exists "cash_entries_delete"         on public.cash_entries;
drop policy if exists "employees_select"            on public.employees;
drop policy if exists "employees_modify"            on public.employees;
drop policy if exists "employees_self_update"       on public.employees;
drop policy if exists "employee_hours_select"       on public.employee_hours;
drop policy if exists "employee_hours_modify"       on public.employee_hours;

-- ----- allowed_users -----
-- Staff (admin/manager) may read the whitelist; everyone else may read ONLY
-- their own row. This prevents an 'employee' login from enumerating other
-- users' usernames / temp_password / emails.
create policy "allowed_users_select" on public.allowed_users
  for select to authenticated
  using (
    public.is_staff()
    or lower(email) = lower(auth.jwt() ->> 'email')
  );

-- Only admins can insert/update/delete the whitelist.
create policy "allowed_users_admin_modify" on public.allowed_users
  for all to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'))
  with check (public.is_admin(auth.jwt() ->> 'email'));

-- ----- cash_entries (staff only: admin + manager) -----
create policy "cash_entries_select" on public.cash_entries
  for select to authenticated
  using (public.is_staff());

create policy "cash_entries_insert" on public.cash_entries
  for insert to authenticated
  with check (
    public.is_staff()
    and (user_id = auth.uid() or user_id is null)
  );

create policy "cash_entries_update" on public.cash_entries
  for update to authenticated
  using (
    public.is_staff()
    and (user_id = auth.uid() or public.is_admin(auth.jwt() ->> 'email'))
  )
  with check (public.is_staff());

create policy "cash_entries_delete" on public.cash_entries
  for delete to authenticated
  using (
    public.is_staff()
    and (user_id = auth.uid() or public.is_admin(auth.jwt() ->> 'email'))
  );

-- ----- employees -----
-- Staff (admin/manager) see all; an employee sees only their own profile row.
create policy "employees_select" on public.employees
  for select to authenticated
  using (
    public.is_staff()
    or id = public.current_employee_id()
    or auth_user_id = auth.uid()
  );

-- Staff can do anything.
create policy "employees_modify" on public.employees
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- An employee may update their own profile row (server action limits columns).
create policy "employees_self_update" on public.employees
  for update to authenticated
  using (id = public.current_employee_id() or auth_user_id = auth.uid())
  with check (id = public.current_employee_id() or auth_user_id = auth.uid());

-- ----- employee_hours (staff only) -----
create policy "employee_hours_select" on public.employee_hours
  for select to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id());

create policy "employee_hours_modify" on public.employee_hours
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- =============================================================
-- VIEW PERMISSIONS
-- =============================================================
grant select on public.employee_hours_computed to authenticated;

-- =============================================================
-- =============================================================
-- STAGE 1: ROTA & WORKFORCE MANAGEMENT
-- =============================================================
-- =============================================================

-- =============================================================
-- TABLE: stores
-- =============================================================
create table if not exists public.stores (
  id                  uuid primary key default gen_random_uuid(),
  code                text unique not null,
  name                text not null,
  latitude            numeric(10,7),
  longitude           numeric(10,7),
  geofence_radius_m   integer not null default 250,
  -- Per-store rota preset times (each store trades on its own hours).
  shift_times         jsonb not null default
    '{"driver_open":"11:30","kitchen_open":"09:00","evening_start":"17:00","close":"23:00"}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Back-fill for existing deployments created before shift_times existed.
alter table public.stores
  add column if not exists shift_times jsonb not null default
    '{"driver_open":"11:30","kitchen_open":"09:00","evening_start":"17:00","close":"23:00"}'::jsonb;

insert into public.stores (code, name, latitude, longitude, geofence_radius_m)
values
  ('stevenage', 'Stevenage Peckers', 51.9036, -0.2014, 250),
  ('hitchin',   'Hitchin Peckers',   51.9498, -0.2830, 250)
on conflict (code) do nothing;

-- =============================================================
-- EXTEND allowed_users: role model (admin | manager | employee),
-- store assignment, and login-account credential columns.
-- =============================================================
alter table public.allowed_users
  add column if not exists store_id uuid references public.stores(id) on delete set null;

-- The store a manager is currently operating as (multi-store switching, see
-- migration 020). Null = fall back to home store_id. Only meaningful for
-- role='manager'; current_user_store_id() reads it via coalesce().
alter table public.allowed_users
  add column if not exists active_store_id uuid references public.stores(id) on delete set null;

-- Login-account columns. Every allowed_users row IS a login account.
--  - username: shown to admin to share; managers/employees log in with it.
--  - temp_password: the generated password, kept so admins can re-share it
--    (internal tool; rotate via the Reset action). Flagged in the handover.
--  - must_change_password: reserved for a future force-change-on-first-login flow.
--  - employee_id: links an 'employee' login account to its HR profile row.
alter table public.allowed_users
  add column if not exists username             text,
  add column if not exists temp_password        text,
  add column if not exists must_change_password boolean not null default true,
  add column if not exists employee_id          uuid references public.employees(id) on delete cascade;

create unique index if not exists allowed_users_username_unique
  on public.allowed_users (lower(username)) where username is not null;

-- Migrate any legacy 'super_admin' rows to 'admin' BEFORE tightening the check.
update public.allowed_users set role = 'admin' where role = 'super_admin';

alter table public.allowed_users
  drop constraint if exists allowed_users_role_check;
-- 'cover_driver' is added by migration 014. Listed here too so re-running this
-- file cannot silently narrow the constraint and lock every cover driver out.
alter table public.allowed_users
  add constraint allowed_users_role_check
  check (role in ('admin','manager','employee','cover_driver'));

-- (Role helper functions current_user_role / is_staff / current_employee_id
--  are defined earlier, before the RLS section.)

-- =============================================================
-- EXTEND employees with full Stage 1 profile
-- =============================================================
alter table public.employees
  add column if not exists date_of_birth        date,
  add column if not exists gender               text,
  add column if not exists position             text,
  add column if not exists employment_start_date date,
  add column if not exists hourly_ni_rate       numeric(8,2),
  add column if not exists hourly_cash_rate     numeric(8,2),
  add column if not exists store_id             uuid references public.stores(id) on delete set null,
  add column if not exists bank_account_name    text,
  add column if not exists bank_name            text,
  add column if not exists account_number       text,
  add column if not exists sort_code            text,
  add column if not exists employment_status    text not null default 'active'
    check (employment_status in ('active','inactive','left')),
  add column if not exists auth_user_id         uuid references auth.users(id) on delete set null,
  add column if not exists email                text;

-- Position dropdown values: Manager, KTM (Supervisor), Kitchen Team Member, Driver, Supervisor

create index if not exists employees_store_idx on public.employees (store_id);
create index if not exists employees_status_idx on public.employees (employment_status);
create unique index if not exists employees_email_unique on public.employees (lower(email)) where email is not null;

-- =============================================================
-- TABLE: rota_shifts
-- One row per employee per day. Day off, scheduled times, manager notes.
-- =============================================================
create table if not exists public.rota_shifts (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id) on delete cascade,
  store_id            uuid not null references public.stores(id) on delete cascade,
  shift_date          date not null,
  start_time          time,
  end_time            time,
  is_day_off          boolean not null default false,
  scheduled_hours     numeric(5,2) not null default 0,
  manager_notes       text,
  same_day_edit_reason text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null
);

create unique index if not exists rota_shifts_unique on public.rota_shifts (employee_id, shift_date);
create index if not exists rota_shifts_date_idx on public.rota_shifts (shift_date);
create index if not exists rota_shifts_store_date_idx on public.rota_shifts (store_id, shift_date);

drop trigger if exists set_rota_shifts_updated_at on public.rota_shifts;
create trigger set_rota_shifts_updated_at
  before update on public.rota_shifts
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: clock_events
-- Crew clock-in / clock-out records with geofence captured location.
-- =============================================================
create table if not exists public.clock_events (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references public.employees(id) on delete cascade,
  shift_id            uuid references public.rota_shifts(id) on delete set null,
  store_id            uuid not null references public.stores(id) on delete cascade,
  event_date          date not null,
  clock_in_at         timestamptz,
  clock_out_at        timestamptz,
  clock_in_lat        numeric(10,7),
  clock_in_lng        numeric(10,7),
  clock_out_lat       numeric(10,7),
  clock_out_lng       numeric(10,7),
  -- Deliveries split into short vs long, each with its own per-driver rate
  -- (see migration 011). Entered by the driver at clock-out.
  short_deliveries_count integer,
  long_deliveries_count  integer,
  -- Deliveries beyond the normal round, per type, each with a reason.
  extra_short_deliveries integer not null default 0,
  extra_long_deliveries  integer not null default 0,
  extra_short_reason     text,
  extra_long_reason      text,
  -- Per-day approval of clocked hours (see migration 016). A manager confirms
  -- each day's hours; the weekly employee_hours row is the sum of approved_hours.
  hours_approved      boolean not null default false,
  approved_hours      numeric(6,2),
  hours_approved_by   uuid references auth.users(id) on delete set null,
  hours_approved_at   timestamptz,
  created_at          timestamptz not null default now()
);

create unique index if not exists clock_events_unique on public.clock_events (employee_id, event_date);
create index if not exists clock_events_date_idx on public.clock_events (event_date);
create index if not exists clock_events_store_date_idx on public.clock_events (store_id, event_date);
create index if not exists clock_events_approval_idx on public.clock_events (hours_approved, event_date);

-- =============================================================
-- TABLE: weekly_deliveries
-- 4-week-average delivery figures entered by manager + Vita Mojo cross-check.
-- =============================================================
create table if not exists public.weekly_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  driver_id           uuid not null references public.employees(id) on delete cascade,
  store_id            uuid not null references public.stores(id) on delete cascade,
  week_start_date     date not null,
  manager_avg_4wk     numeric(8,2),
  vita_mojo_count     integer,
  notes               text,
  reason              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists weekly_deliveries_unique on public.weekly_deliveries (driver_id, week_start_date);

drop trigger if exists set_weekly_deliveries_updated_at on public.weekly_deliveries;
create trigger set_weekly_deliveries_updated_at
  before update on public.weekly_deliveries
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: alerts
-- System-generated alerts visible on manager dashboard.
-- =============================================================
create table if not exists public.alerts (
  id                  uuid primary key default gen_random_uuid(),
  alert_type          text not null,
  severity            text not null default 'warning' check (severity in ('info','warning','critical')),
  store_id            uuid references public.stores(id) on delete set null,
  employee_id         uuid references public.employees(id) on delete set null,
  shift_id            uuid references public.rota_shifts(id) on delete set null,
  title               text not null,
  message             text not null,
  payload             jsonb,
  resolved            boolean not null default false,
  resolved_at         timestamptz,
  resolved_by         uuid references auth.users(id) on delete set null,
  resolution_note     text,
  created_at          timestamptz not null default now()
);

create index if not exists alerts_resolved_idx on public.alerts (resolved, created_at desc);
create index if not exists alerts_store_idx on public.alerts (store_id);
create index if not exists alerts_type_idx on public.alerts (alert_type);

-- Dedup of open alerts is handled in app code (app/actions/alerts.ts -> upsertAlert).
-- We can't use a partial unique index keyed on created_at::date because timestamptz->date
-- is STABLE (timezone-dependent), not IMMUTABLE, which Postgres requires for index expressions.

-- =============================================================
-- TABLE: audit_log
-- All changes to records, rates, rota shifts.
-- =============================================================
create table if not exists public.audit_log (
  id                  uuid primary key default gen_random_uuid(),
  actor_id            uuid references auth.users(id) on delete set null,
  actor_email         text,
  action              text not null,
  entity              text not null,
  entity_id           text,
  changes             jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists audit_log_entity_idx on public.audit_log (entity, entity_id);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);

-- =============================================================
-- VIEW: employee_weekly_summary
-- For each employee + week_start, total scheduled hrs, total wages (NI + cash),
-- 4-week rolling average hours from prior weeks.
-- =============================================================
drop view if exists public.employee_weekly_summary;
create view public.employee_weekly_summary with (security_invoker = true) as
with weekly_rota as (
  select
    rs.employee_id,
    date_trunc('week', rs.shift_date)::date as week_start_date,
    sum(case when rs.is_day_off then 0 else rs.scheduled_hours end) as scheduled_hours
  from public.rota_shifts rs
  group by rs.employee_id, date_trunc('week', rs.shift_date)
),
weekly_actual as (
  select
    ce.employee_id,
    date_trunc('week', ce.event_date)::date as week_start_date,
    sum(
      case
        when ce.clock_in_at is not null and ce.clock_out_at is not null
        then extract(epoch from (ce.clock_out_at - ce.clock_in_at)) / 3600.0
        else 0
      end
    ) as actual_hours,
    sum(coalesce(ce.short_deliveries_count, 0) + coalesce(ce.long_deliveries_count, 0)) as deliveries_total
  from public.clock_events ce
  group by ce.employee_id, date_trunc('week', ce.event_date)
)
select
  e.id as employee_id,
  e.name as employee_name,
  e.position,
  e.store_id,
  coalesce(wr.week_start_date, wa.week_start_date) as week_start_date,
  coalesce(wr.scheduled_hours, 0) as scheduled_hours,
  coalesce(wa.actual_hours, 0) as actual_hours,
  coalesce(wa.deliveries_total, 0) as deliveries_total,
  e.hourly_ni_rate,
  e.hourly_cash_rate,
  -- Wage split: first 20h = NI (bank), remainder = cash if cash rate set
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0) as scheduled_ni_wages,
  greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0) as scheduled_cash_wages,
  least(coalesce(wr.scheduled_hours, 0), 20) * coalesce(e.hourly_ni_rate, e.hourly_rate, 0)
    + greatest(coalesce(wr.scheduled_hours, 0) - 20, 0) * coalesce(e.hourly_cash_rate, 0)
    as scheduled_total_wages
from public.employees e
left join weekly_rota wr on wr.employee_id = e.id
left join weekly_actual wa on wa.employee_id = e.id
  and wa.week_start_date = wr.week_start_date;

-- =============================================================
-- ROW LEVEL SECURITY for new tables
-- =============================================================
alter table public.stores            enable row level security;
alter table public.rota_shifts       enable row level security;
alter table public.clock_events      enable row level security;
alter table public.weekly_deliveries enable row level security;
alter table public.alerts            enable row level security;
alter table public.audit_log         enable row level security;

-- Drop existing to keep rerunnable
drop policy if exists "stores_select"            on public.stores;
drop policy if exists "stores_modify"            on public.stores;
drop policy if exists "rota_shifts_select"       on public.rota_shifts;
drop policy if exists "rota_shifts_modify"       on public.rota_shifts;
drop policy if exists "clock_events_select"      on public.clock_events;
drop policy if exists "clock_events_modify"      on public.clock_events;
drop policy if exists "clock_events_insert"      on public.clock_events;
drop policy if exists "clock_events_update"      on public.clock_events;
drop policy if exists "clock_events_delete"      on public.clock_events;
drop policy if exists "weekly_deliveries_select" on public.weekly_deliveries;
drop policy if exists "weekly_deliveries_modify" on public.weekly_deliveries;
drop policy if exists "alerts_select"            on public.alerts;
drop policy if exists "alerts_modify"            on public.alerts;
drop policy if exists "audit_log_select"         on public.audit_log;
drop policy if exists "audit_log_insert"         on public.audit_log;

-- ----- stores: everyone allowed can read (geofence); admin edits -----
create policy "stores_select" on public.stores
  for select to authenticated
  using (public.is_allowed(auth.jwt() ->> 'email'));

create policy "stores_modify" on public.stores
  for all to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'))
  with check (public.is_admin(auth.jwt() ->> 'email'));

-- ----- rota_shifts: staff see/edit all; employee reads only own -----
create policy "rota_shifts_select" on public.rota_shifts
  for select to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id());

create policy "rota_shifts_modify" on public.rota_shifts
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ----- clock_events: staff all; employee reads/writes only own -----
create policy "clock_events_select" on public.clock_events
  for select to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_events_insert" on public.clock_events
  for insert to authenticated
  with check (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_events_update" on public.clock_events
  for update to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id())
  with check (public.is_staff() or employee_id = public.current_employee_id());

create policy "clock_events_delete" on public.clock_events
  for delete to authenticated
  using (public.is_staff());

-- ----- weekly_deliveries: staff only -----
create policy "weekly_deliveries_select" on public.weekly_deliveries
  for select to authenticated
  using (public.is_staff());

create policy "weekly_deliveries_modify" on public.weekly_deliveries
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ----- alerts: staff only -----
create policy "alerts_select" on public.alerts
  for select to authenticated
  using (public.is_staff());

create policy "alerts_modify" on public.alerts
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ----- audit_log: staff read; any allowed user can write (e.g. clock events) -----
create policy "audit_log_select" on public.audit_log
  for select to authenticated
  using (public.is_staff());

create policy "audit_log_insert" on public.audit_log
  for insert to authenticated
  with check (public.is_allowed(auth.jwt() ->> 'email'));

grant select on public.employee_weekly_summary to authenticated;

-- =============================================================
-- SEED HINT — first ADMIN account
-- The admin is the only account created by hand. Managers & employees are
-- then provisioned from inside the app (admin -> /managers and /employees),
-- which auto-creates their auth user + login credentials.
--
-- 1) Create the auth user in Supabase Authentication > Users (email + password).
-- 2) Whitelist that email as an admin:
--
--   insert into public.allowed_users (email, name, role)
--   values ('you@example.com', 'Your Name', 'admin')
--   on conflict (email) do update set role = 'admin';
--
-- App-side provisioning requires SUPABASE_SERVICE_ROLE_KEY in the server env
-- (Project Settings > API > service_role key). Never expose it to the browser.
-- =============================================================

-- =============================================================
-- =============================================================
-- STAGE 1 POLISH: SCHEDULES, SETTINGS, FORCED PASSWORD CHANGE
-- (All idempotent — safe to re-run.)
-- =============================================================
-- =============================================================

-- =============================================================
-- TABLE: employee_schedules
-- The employee's RECURRING weekly pattern (the "contracted" default), one row
-- per weekday (0=Mon .. 6=Sun). This is the baseline the rota is built from and
-- that actual clock-in/out is measured against (planned vs actual, missed shift).
-- Distinct from rota_shifts, which is the actual published rota for real dates.
-- =============================================================
create table if not exists public.employee_schedules (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  is_working  boolean not null default true,
  start_time  time,
  end_time    time,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  unique (employee_id, weekday)
);

create index if not exists employee_schedules_emp_idx on public.employee_schedules (employee_id);

drop trigger if exists set_employee_schedules_updated_at on public.employee_schedules;
create trigger set_employee_schedules_updated_at
  before update on public.employee_schedules
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: app_settings
-- Key/JSONB store for configurable alert thresholds, minimum-wage bands, and
-- email-notification config. App code (lib/settings.ts) supplies defaults and
-- merges any rows here over them, so an empty table still works.
-- =============================================================
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

drop trigger if exists set_app_settings_updated_at on public.app_settings;
create trigger set_app_settings_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

-- =============================================================
-- ROW LEVEL SECURITY for the new tables
-- =============================================================
alter table public.employee_schedules enable row level security;
alter table public.app_settings        enable row level security;

drop policy if exists "employee_schedules_select" on public.employee_schedules;
drop policy if exists "employee_schedules_modify" on public.employee_schedules;
drop policy if exists "app_settings_select"       on public.app_settings;
drop policy if exists "app_settings_modify"       on public.app_settings;

-- Staff see/edit all schedules; an employee may read only their own.
create policy "employee_schedules_select" on public.employee_schedules
  for select to authenticated
  using (public.is_staff() or employee_id = public.current_employee_id());

create policy "employee_schedules_modify" on public.employee_schedules
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- Any staff member may read settings (managers need thresholds/min-wage bands);
-- only admins may change them.
create policy "app_settings_select" on public.app_settings
  for select to authenticated
  using (public.is_staff());

create policy "app_settings_modify" on public.app_settings
  for all to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'))
  with check (public.is_admin(auth.jwt() ->> 'email'));

-- =============================================================
-- FORCED PASSWORD CHANGE — backfill
-- must_change_password defaults to true, but existing live accounts have been
-- in use without enforcement. Only force accounts still sitting on an
-- admin-shared temp password; anyone with a null temp_password (real-email
-- admins, or users who already changed) is left untouched.
-- =============================================================
update public.allowed_users set must_change_password = false where temp_password is null;

-- =============================================================
-- =============================================================
-- STAGE 2: CASH FLOW MANAGEMENT MODULE (PRG-CF-001)
-- Daily envelope reconciliation, Saturday cash + delivery wage payout,
-- weekly payout summaries, running cash balance & cash alerts.
-- (All idempotent — safe to re-run.)
-- =============================================================
-- =============================================================

-- Per-driver rates paid per completed delivery (£), split into short and long
-- deliveries (see migration 011). Drive delivery wages in the Saturday payout.
-- Only meaningful for employees whose position = Driver.
alter table public.employees
  add column if not exists short_delivery_rate numeric(8,2),
  add column if not exists long_delivery_rate  numeric(8,2);

-- Store of the currently-authenticated login account (for manager scoping).
-- Prefers the manager's ACTIVE store (multi-store switching, migration 020),
-- falling back to their home store. Employees have no active_store_id, so this
-- returns their store_id unchanged.
create or replace function public.current_user_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(active_store_id, store_id) from public.allowed_users
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

-- True if the current user may see/act on a given store: admins see all,
-- managers see only their assigned store.
create or replace function public.can_access_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_admin(auth.jwt() ->> 'email')
    or (public.is_staff() and p_store_id = public.current_user_store_id());
$$;

-- =============================================================
-- TABLE: daily_cash_entries
-- One reconciliation row per store per day: Vita Mojo cash sales vs the cash
-- physically placed in the envelope, the auto-computed difference, and a reason
-- (mandatory when a difference exists — enforced in the app + a CHECK below).
-- =============================================================
create table if not exists public.daily_cash_entries (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  entry_date         date not null,
  vita_mojo_sales    numeric(10,2) not null,
  envelope_amount    numeric(10,2) not null,
  -- Cash spent on supermarket / supplies for the day (informational; not part
  -- of the Vita-vs-envelope reconciliation difference).
  supermarket_expenses numeric(10,2) not null default 0,
  -- Positive = shortfall (Vita > envelope); negative = surplus.
  difference         numeric(10,2) generated always as (vita_mojo_sales - envelope_amount) stored,
  reason             text,
  is_late            boolean not null default false,
  submitted_by       uuid references auth.users(id) on delete set null,
  submitted_by_name  text,
  submitted_by_email text,
  edited_by_name     text,
  edited_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- The envelope is expected to equal sales − supermarket expenses; a reason is
  -- only required when it's overridden to a different figure (see migration 005).
  constraint daily_cash_entries_reason_required
    check (
      envelope_amount = vita_mojo_sales - supermarket_expenses
      or (reason is not null and length(btrim(reason)) > 0)
    )
);

-- One entry per store per day (the app upserts; no duplicate days).
create unique index if not exists daily_cash_entries_store_day_unique
  on public.daily_cash_entries (store_id, entry_date);
create index if not exists daily_cash_entries_date_idx
  on public.daily_cash_entries (entry_date desc);

drop trigger if exists set_daily_cash_entries_updated_at on public.daily_cash_entries;
create trigger set_daily_cash_entries_updated_at
  before update on public.daily_cash_entries
  for each row execute function public.set_updated_at();

-- Date-window guard (see migration 004): entries only for today or the past
-- 2 days (admins may back-date), never the future; is_late is server-derived.
create or replace function public.enforce_daily_cash_entry_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Europe/London')::date;
begin
  if auth.jwt() is null or (auth.jwt() ->> 'role') = 'service_role' then
    return new;
  end if;
  if new.entry_date > today then
    raise exception 'Cash entries cannot be dated in the future.';
  end if;
  if not public.is_admin(auth.jwt() ->> 'email') and new.entry_date < today - 2 then
    raise exception 'Cash entries can only be added for today or the past 2 days.';
  end if;
  new.is_late := new.entry_date < today;
  return new;
end;
$$;

drop trigger if exists daily_cash_entries_date_window on public.daily_cash_entries;
create trigger daily_cash_entries_date_window
  before insert or update on public.daily_cash_entries
  for each row execute function public.enforce_daily_cash_entry_window();

-- =============================================================
-- TABLE: cash_payouts
-- One header row per store per week (Monday-anchored) capturing the Saturday
-- pre-payment summary and confirmation/locking state.
-- =============================================================
create table if not exists public.cash_payouts (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid not null references public.stores(id) on delete cascade,
  week_start_date        date not null,          -- Monday of the pay week
  payment_date           date,                   -- the Saturday wages were paid
  status                 text not null default 'draft'
                           check (status in ('draft','confirmed')),
  opening_balance        numeric(10,2) not null default 0,  -- carried-forward surplus
  cash_collected         numeric(10,2) not null default 0,  -- sum of envelopes
  logged_differences     numeric(10,2) not null default 0,  -- vita - envelopes
  actual_cash_available  numeric(10,2) not null default 0,
  total_cash_wages       numeric(10,2) not null default 0,
  total_delivery_wages   numeric(10,2) not null default 0,
  grand_total_wages      numeric(10,2) not null default 0,
  post_office_draw       numeric(10,2) not null default 0,  -- shortfall to draw
  surplus_carry_forward  numeric(10,2) not null default 0,
  locked                 boolean not null default false,
  confirmed_by           uuid references auth.users(id) on delete set null,
  confirmed_by_name      text,
  confirmed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists cash_payouts_store_week_unique
  on public.cash_payouts (store_id, week_start_date);
create index if not exists cash_payouts_week_idx
  on public.cash_payouts (week_start_date desc);

drop trigger if exists set_cash_payouts_updated_at on public.cash_payouts;
create trigger set_cash_payouts_updated_at
  before update on public.cash_payouts
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: cash_payout_lines
-- One row per employee paid in a given weekly payout (snapshot of the wage
-- breakdown so historical records never drift if rates/hours change later).
-- =============================================================
create table if not exists public.cash_payout_lines (
  id               uuid primary key default gen_random_uuid(),
  payout_id        uuid not null references public.cash_payouts(id) on delete cascade,
  employee_id      uuid references public.employees(id) on delete set null,
  employee_name    text not null,
  role             text,
  cash_hours       numeric(6,2) not null default 0,
  cash_rate        numeric(8,2) not null default 0,
  cash_wage        numeric(10,2) not null default 0,
  short_deliveries_count integer not null default 0,
  long_deliveries_count  integer not null default 0,
  -- Extra ("miscellaneous") drops beyond the normal round — see migration 021.
  short_misc_count       integer not null default 0,
  long_misc_count        integer not null default 0,
  short_delivery_rate    numeric(8,2) not null default 0,
  long_delivery_rate     numeric(8,2) not null default 0,
  delivery_wages   numeric(10,2) not null default 0,
  total_payment    numeric(10,2) not null default 0,
  is_paid          boolean not null default false,
  paid_at          timestamptz,
  paid_by_name     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists cash_payout_lines_unique
  on public.cash_payout_lines (payout_id, employee_id);
create index if not exists cash_payout_lines_payout_idx
  on public.cash_payout_lines (payout_id);

drop trigger if exists set_cash_payout_lines_updated_at on public.cash_payout_lines;
create trigger set_cash_payout_lines_updated_at
  before update on public.cash_payout_lines
  for each row execute function public.set_updated_at();

-- =============================================================
-- ROW LEVEL SECURITY — cash flow tables
-- Admins see/act on all stores; managers only on their assigned store.
-- =============================================================
alter table public.daily_cash_entries enable row level security;
alter table public.cash_payouts        enable row level security;
alter table public.cash_payout_lines   enable row level security;

drop policy if exists "daily_cash_entries_select" on public.daily_cash_entries;
drop policy if exists "daily_cash_entries_modify" on public.daily_cash_entries;
drop policy if exists "daily_cash_entries_delete" on public.daily_cash_entries;
drop policy if exists "cash_payouts_select"       on public.cash_payouts;
drop policy if exists "cash_payouts_modify"       on public.cash_payouts;
drop policy if exists "cash_payouts_delete"       on public.cash_payouts;
drop policy if exists "cash_payout_lines_select"  on public.cash_payout_lines;
drop policy if exists "cash_payout_lines_modify"  on public.cash_payout_lines;

-- ----- daily_cash_entries -----
create policy "daily_cash_entries_select" on public.daily_cash_entries
  for select to authenticated
  using (public.can_access_store(store_id));

-- Insert/update allowed for staff scoped to their store; locked weeks are still
-- editable here (the lock is enforced on payouts, not daily entries).
create policy "daily_cash_entries_modify" on public.daily_cash_entries
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

-- Only Super Admins may delete a submitted cash entry (deletion logged in app).
create policy "daily_cash_entries_delete" on public.daily_cash_entries
  for delete to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'));

-- ----- cash_payouts -----
create policy "cash_payouts_select" on public.cash_payouts
  for select to authenticated
  using (public.can_access_store(store_id));

create policy "cash_payouts_modify" on public.cash_payouts
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

create policy "cash_payouts_delete" on public.cash_payouts
  for delete to authenticated
  using (public.is_admin(auth.jwt() ->> 'email'));

-- ----- cash_payout_lines (scoped through the parent payout's store) -----
create policy "cash_payout_lines_select" on public.cash_payout_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.cash_payouts p
      where p.id = payout_id and public.can_access_store(p.store_id)
    )
  );

create policy "cash_payout_lines_modify" on public.cash_payout_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.cash_payouts p
      where p.id = payout_id and public.can_access_store(p.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.cash_payouts p
      where p.id = payout_id and public.can_access_store(p.store_id)
    )
  );

-- =============================================================
-- Migration 017 — Manager rota (scheduled shifts for managers)
--
-- Managers are login accounts (allowed_users, role='manager'), not employees,
-- so the crew rota_shifts table (keyed on employee_id) can't hold their
-- schedule. This mirrors rota_shifts but keyed on the login account, and
-- drops the wage-only fields (shift_type preset, same_day_edit_reason) since
-- a manager's fixed_daily_wage (see migration 013) never depends on rota or
-- clock data — this table is for staffing visibility + attendance monitoring
-- only, shown above the employee rota on the admin Rota page.
-- =============================================================

create table if not exists public.manager_shifts (
  id              uuid primary key default gen_random_uuid(),
  manager_id      uuid not null references public.allowed_users(id) on delete cascade,
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

create unique index if not exists manager_shifts_unique on public.manager_shifts (manager_id, shift_date);
create index if not exists manager_shifts_date_idx on public.manager_shifts (shift_date);
create index if not exists manager_shifts_store_date_idx on public.manager_shifts (store_id, shift_date);

drop trigger if exists set_manager_shifts_updated_at on public.manager_shifts;
create trigger set_manager_shifts_updated_at
  before update on public.manager_shifts
  for each row execute function public.set_updated_at();

alter table public.manager_shifts enable row level security;

drop policy if exists "manager_shifts_select" on public.manager_shifts;
drop policy if exists "manager_shifts_modify" on public.manager_shifts;

-- Staff (admin/manager) can view; only admin assigns manager shifts — managers
-- are provisioned/managed by admin only (see /managers, the account-creation
-- flow), and the edit UI only exists on the admin Rota page today.
create policy "manager_shifts_select" on public.manager_shifts
  for select to authenticated
  using (public.is_staff());

create policy "manager_shifts_modify" on public.manager_shifts
  for all to authenticated
  using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

grant all on public.manager_shifts to anon, authenticated, service_role;
    )
  );

-- =============================================================
-- =============================================================
-- STAGE 3: MANAGER CLOCK-IN + ROTA SHIFT PRESETS
-- (mirrors supabase/migrations/012_manager_clock_and_shift_presets.sql)
-- All idempotent — safe to re-run.
-- =============================================================
-- =============================================================

-- Rota preset label: which "Open→Close" / "Evening→Close" preset produced a
-- shift. Null = custom times / day off / legacy.
alter table public.rota_shifts
  add column if not exists shift_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rota_shifts_shift_type_check'
  ) then
    alter table public.rota_shifts
      add constraint rota_shifts_shift_type_check
      check (shift_type is null or shift_type in ('open_close','evening_close'));
  end if;
end $$;

-- A manager's FIXED daily wage. Shown on the Live dashboard for monitoring;
-- it never drives any pay calculation.
alter table public.allowed_users
  add column if not exists fixed_daily_wage numeric(10,2);

-- Managers are login accounts (allowed_users, role='manager') with no employees
-- row, so the crew clock_events table (keyed on employee_id) can't hold their
-- clock events. This mirrors clock_events but is keyed on the login account.
create table if not exists public.manager_clock_events (
  id            uuid primary key default gen_random_uuid(),
  manager_id    uuid not null references public.allowed_users(id) on delete cascade,
  store_id      uuid references public.stores(id) on delete set null,
  event_date    date not null,
  clock_in_at   timestamptz,
  clock_out_at  timestamptz,
  clock_in_lat  numeric(10,7),
  clock_in_lng  numeric(10,7),
  clock_out_lat numeric(10,7),
  clock_out_lng numeric(10,7),
  created_at    timestamptz not null default now(),
  unique (manager_id, event_date)
);

create index if not exists manager_clock_events_date_idx
  on public.manager_clock_events (event_date);
create index if not exists manager_clock_events_manager_idx
  on public.manager_clock_events (manager_id, event_date);

-- allowed_users.id of the current login (parallels current_employee_id()).
create or replace function public.current_allowed_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.allowed_users
  where lower(email) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

alter table public.manager_clock_events enable row level security;

drop policy if exists "manager_clock_select" on public.manager_clock_events;
drop policy if exists "manager_clock_insert" on public.manager_clock_events;
drop policy if exists "manager_clock_update" on public.manager_clock_events;

-- Admin sees all; a manager sees/writes only their own row.
create policy "manager_clock_select" on public.manager_clock_events
  for select to authenticated
  using (
    public.is_admin(auth.jwt() ->> 'email')
    or manager_id = public.current_allowed_user_id()
  );

create policy "manager_clock_insert" on public.manager_clock_events
  for insert to authenticated
  with check (manager_id = public.current_allowed_user_id());

create policy "manager_clock_update" on public.manager_clock_events
  for update to authenticated
  using (manager_id = public.current_allowed_user_id())
  with check (manager_id = public.current_allowed_user_id());

grant all on public.manager_clock_events to anon, authenticated, service_role;

-- =============================================================
-- TABLE: geofence_failures  (see migrations/014_geofence_failures.sql)
-- Persists failed clock-in/out geofence checks (reported position, accuracy,
-- nearest store, distance vs radius) so a failed attempt can be diagnosed
-- after the fact instead of guessed at.
-- =============================================================
create table if not exists public.geofence_failures (
  id                  uuid primary key default gen_random_uuid(),
  occurred_at         timestamptz not null default now(),
  actor_email         text not null,
  employee_id         uuid references public.employees(id) on delete set null,
  manager_id          uuid references public.allowed_users(id) on delete set null,
  action              text not null check (action in ('clock_in','clock_out')),
  attempted_lat       numeric(10,7) not null,
  attempted_lng       numeric(10,7) not null,
  accuracy_m          numeric(10,2),
  nearest_store_id    uuid references public.stores(id) on delete set null,
  -- Snapshot of the store name at the time, so the row still reads clearly
  -- even if the store is later renamed or removed.
  nearest_store_name  text,
  distance_m          numeric(10,2) not null,
  radius_m            integer not null,
  message             text not null
);

create index if not exists geofence_failures_occurred_idx on public.geofence_failures (occurred_at desc);
create index if not exists geofence_failures_employee_idx on public.geofence_failures (employee_id);
create index if not exists geofence_failures_manager_idx  on public.geofence_failures (manager_id);

alter table public.geofence_failures enable row level security;

drop policy if exists "geofence_failures_select" on public.geofence_failures;
drop policy if exists "geofence_failures_insert" on public.geofence_failures;

-- Staff (admin/manager) can review; any allowed user can write their own
-- failed attempt (mirrors audit_log — the crew member logs their own record).
create policy "geofence_failures_select" on public.geofence_failures
  for select to authenticated
  using (public.is_staff());

create policy "geofence_failures_insert" on public.geofence_failures
  for insert to authenticated
  with check (public.is_allowed(auth.jwt() ->> 'email'));

grant all on public.geofence_failures to anon, authenticated, service_role;
