-- =============================================================
-- Migration 026 — Manager-entered clock times
--
-- Run AFTER 023/024/025 (this touches cover_driver_clock_events).
--
-- A clock-in can now be recorded two ways:
--   1. the employee self-clocks inside the geofence (unchanged), or
--   2. a manager records it for someone who forgot.
--
-- (2) BYPASSES THE GEOFENCE, which is the geofence's whole purpose — so a
-- manager-entered row must be impossible to confuse with a verified one. These
-- columns make that explicit at the database level, mirroring the pattern
-- `auto_clocked_out` already established for assumed clock-out times.
--
-- A second, quieter signal: manual rows have NULL clock_in_lat/lng. Any row
-- without coordinates was never location-verified.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

alter table public.clock_events
  add column if not exists manual_entry        boolean not null default false,
  add column if not exists manual_entry_by     uuid references auth.users(id) on delete set null,
  add column if not exists manual_entry_at     timestamptz,
  add column if not exists manual_entry_reason text,
  -- 'in' | 'out' | 'both' — which timestamps the manager supplied. Lets the UI
  -- say the clock-IN was manager-entered without implying the clock-out was:
  -- the common case is a manager recording a missed start, then the employee
  -- clocking out themselves at the end of the shift.
  add column if not exists manual_entry_fields text;

comment on column public.clock_events.manual_entry is
  'True when a manager recorded these times by hand. Such a row was NOT geofence-verified (clock_in_lat/lng are null).';

alter table public.cover_driver_clock_events
  add column if not exists manual_entry        boolean not null default false,
  add column if not exists manual_entry_by     uuid references auth.users(id) on delete set null,
  add column if not exists manual_entry_at     timestamptz,
  add column if not exists manual_entry_reason text,
  add column if not exists manual_entry_fields text;

comment on column public.cover_driver_clock_events.manual_entry is
  'True when a manager recorded these times by hand. Such a row was NOT geofence-verified.';

-- Surfacing manual days for review (an owner spotting patterns, or an audit).
create index if not exists clock_events_manual_idx
  on public.clock_events (manual_entry, event_date desc) where manual_entry;
create index if not exists cover_driver_clock_manual_idx
  on public.cover_driver_clock_events (manual_entry, event_date desc) where manual_entry;

-- No RLS change needed: clock_events_insert/update already allow public.is_staff(),
-- and the cover_driver_clock_* policies already allow can_access_store(store_id).
