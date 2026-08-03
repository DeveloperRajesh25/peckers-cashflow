-- =============================================================
-- Migration 032 — Multiple scheduled shifts per employee per day
--
-- Run AFTER 031. ADDITIVE for data (no rows are touched); the only
-- destructive part is dropping a UNIQUE constraint, which never deletes data
-- and is always safe to re-run.
--
-- THE PROBLEM
-- rota_shifts_unique enforced exactly one row per (employee_id, shift_date).
-- A manager who needed to book a split day — e.g. 09:00-13:00 then again
-- 17:00-21:00 — had nowhere to put the second shift: the cell only ever held
-- one start/end pair, so the only workaround was one 09:00-21:00 block that
-- overstates hours by the gap in the middle.
--
-- THE SHAPE OF THE FIX
-- rota_shifts becomes a plain list: any number of rows may share an
-- (employee_id, shift_date). Every reader that summed scheduled_hours already
-- summed by GROUP BY employee/week (see employee_weekly_summary in migration
-- 029) or by iterating the full list, so the aggregate math needs no schema
-- change at all — only the app code that assumed "one row = one cell" does.
--
-- Nothing here changes clock_events / clock_sessions (migration 029), which
-- already handle a person working multiple shifts in a day on the ATTENDANCE
-- side. This migration is the scheduling-side counterpart.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

drop index if exists public.rota_shifts_unique;

-- Non-unique index covering the same columns, so the common
-- "shifts for this employee on this day" lookup stays index-backed.
create index if not exists rota_shifts_employee_date_idx
  on public.rota_shifts (employee_id, shift_date);
