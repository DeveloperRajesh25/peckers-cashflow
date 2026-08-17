-- =============================================================
-- Migration 043 — An early clock-in needs the manager's OTP
--
-- Run AFTER 042. ADDITIVE ONLY: one new table, no existing column, constraint,
-- index, policy or view is touched. Safe to run BEFORE the code ships — nothing
-- currently deployed reads or writes any of this (the rule migration 027 nearly
-- broke; see Update 65).
--
-- THE PROBLEM
-- An employee booked at 17:00 who is standing near the store can clock in at
-- 16:30 and be paid for the extra half hour. The only defence today is a manager
-- noticing the discrepancy on Daily Approval, which does not reliably happen —
-- and blocking early clock-ins outright is wrong, because managers do sometimes
-- ASK someone to start early.
--
-- THE SHAPE OF THE FIX
-- The manager authorises each early start in real time. Clocking in before the
-- booked start is refused until the employee enters a 4-digit code the manager
-- reads to them over the phone; the code appears on the Live board against that
-- employee, and the day afterwards shows in a "started early" log.
--
-- Why a TABLE and not a column on clock_events: the request exists BEFORE any
-- clock row does, and most requests never become one (declined, expired, given
-- up on). It is an authorisation record with its own lifecycle, and keeping it
-- separate is also what keeps it out of pay — see below.
--
-- THE TWO-STEP LOCATION DESIGN, which is the whole reason this table has
-- coordinates on it. MAX_FIX_AGE_MS is 120s and geofence-verify.ts refuses
-- anything older (Update 106), but a phone call to the manager takes longer than
-- that. "Hold the original fix and submit it later" therefore cannot work — the
-- server would correctly reject it. So the location verdict moves to step ONE:
--
--   1. REQUEST  full detectStoreForLocation against a FRESH fix, exactly as an
--               ordinary clock-in does. The verified store and the coordinates
--               that proved it are persisted on the row below.
--   2. CONSUME  no location at all. The store was already verified; the OTP is
--               the authorisation, and expires_at bounds how stale that
--               verification can be.
--
-- The geofence is not weakened by this: the fix that proves where the person is
-- standing is still captured at the button press and still judged by the shared
-- verifier. It is simply judged 20 minutes earlier in the conversation.
--
-- NOT PAY DATA. An OTP clock-in writes an ordinary clock_events + clock_sessions
-- pair and is approved and paid exactly like any other shift. This table is an
-- audit sidecar; no payout, approval or rollup query reads it.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- TABLE: early_clock_in_requests — one authorisation attempt
-- =============================================================
create table if not exists public.early_clock_in_requests (
  id                   uuid primary key default gen_random_uuid(),
  employee_id          uuid not null references public.employees(id) on delete cascade,
  -- The store detectStoreForLocation verified at REQUEST time, not the
  -- employee's home store and not one the client asked for.
  store_id             uuid not null references public.stores(id),
  event_date           date not null,
  -- The booked shift being started early. Nullable and ON DELETE SET NULL: a
  -- manager re-cutting the rota afterwards must not erase the audit record.
  shift_id             uuid references public.rota_shifts(id) on delete set null,
  -- Same type as rota_shifts.start_time, so the booked start is stored as the
  -- rota holds it rather than reformatted into text.
  scheduled_start      time,
  otp_code             text not null,
  status               text not null default 'pending'
                         check (status in ('pending','used','expired','cancelled','locked')),
  requested_at         timestamptz not null default now(),
  expires_at           timestamptz not null,
  consumed_at          timestamptz,
  clock_event_id       uuid references public.clock_events(id) on delete set null,
  actual_clock_in_at   timestamptz,
  -- Wrong codes entered so far. Capped in the server action, which flips the row
  -- to 'locked' at the limit rather than letting it be brute-forced.
  attempts             smallint not null default 0,
  -- The fix that satisfied the geofence at request time. Kept so "why was this
  -- early start authorised at that store" is answerable from data later, the
  -- same reason geofence_failures records the position of a refusal.
  requested_lat        numeric,
  requested_lng        numeric,
  requested_accuracy_m numeric,
  cancelled_by         uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);

comment on table public.early_clock_in_requests is
  'Manager authorisation for a clock-in before the booked shift start. An audit sidecar — never read by approval or payout logic.';
comment on column public.early_clock_in_requests.otp_code is
  'The 4 digits the manager reads out. READABLE BY STAFF ONLY — the employee it gates must never be able to select it, which is what the RLS below enforces; their own client learns status through a server action that strips this column.';
comment on column public.early_clock_in_requests.status is
  'pending = live, waiting on the employee · used = an early clock-in was made with it · expired = its TTL passed unused · cancelled = the manager denied it or the employee backed out · locked = too many wrong codes, the manager must issue a new one.';
comment on column public.early_clock_in_requests.store_id is
  'SNAPSHOT of the store detectStoreForLocation verified at REQUEST time. The consume step deliberately takes no location — a phone call outlives MAX_FIX_AGE_MS — so this column, not a second geofence check, is what decides where the shift is recorded.';

-- One live request per person: a second attempt REPLACES the first (the action
-- cancels it) rather than leaving two codes on the manager's screen.
create unique index if not exists early_clock_in_requests_one_pending
  on public.early_clock_in_requests (employee_id)
  where status = 'pending';

-- The Live board's query: today's rows for the store(s) being viewed.
create index if not exists early_clock_in_requests_date_store_idx
  on public.early_clock_in_requests (event_date, store_id);

-- =============================================================
-- RLS — the gated employee must never read their own code
--
-- is_staff() is ('admin','manager') and nothing else (schema.sql; the note in
-- migration 023 says the same of cover drivers), so an `employee` login fails
-- every policy here and cannot select the row at all — not just the column.
-- That is the property the whole feature rests on, so it is asserted rather
-- than assumed: there is deliberately NO own-row clause of the kind
-- clock_sessions_select carries.
--
-- The employee-triggered writes (requesting a code, consuming it) therefore
-- cannot go through the caller's session and run through createAdminClient()
-- in the server action instead, which is why that action fails closed when
-- provisioning is not configured.
-- =============================================================
alter table public.early_clock_in_requests enable row level security;

drop policy if exists "early_clock_in_requests_select" on public.early_clock_in_requests;
drop policy if exists "early_clock_in_requests_insert" on public.early_clock_in_requests;
drop policy if exists "early_clock_in_requests_update" on public.early_clock_in_requests;
drop policy if exists "early_clock_in_requests_delete" on public.early_clock_in_requests;

create policy "early_clock_in_requests_select" on public.early_clock_in_requests
  for select to authenticated
  using (public.is_staff());

create policy "early_clock_in_requests_insert" on public.early_clock_in_requests
  for insert to authenticated
  with check (public.is_staff());

create policy "early_clock_in_requests_update" on public.early_clock_in_requests
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

create policy "early_clock_in_requests_delete" on public.early_clock_in_requests
  for delete to authenticated
  using (public.is_staff());

grant all on public.early_clock_in_requests to anon, authenticated, service_role;

-- =============================================================
-- Backfill: none. There is no history of early starts to reconstruct, and no
-- existing figure anywhere moves by a penny.
-- =============================================================
