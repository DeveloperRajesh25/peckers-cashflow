-- =============================================================
-- Migration 027 — Cover drivers on the Tuesday payout sheet
--
-- Run AFTER 023_cover_drivers.sql (this references cover_drivers).
--
-- Until now a cover driver's approved cash never reached the payout sheet: it
-- showed on the Employees page and the Live board, but the sheet the cash is
-- actually counted against listed employees only. So a weekend with two cover
-- drivers meant a few hundred pounds leaving the till unaccounted for.
--
-- A payout line is now EITHER an employee line or a cover driver line. Same
-- table on purpose: the sheet, its totals, the paid tick and the history view
-- all keep working with no second code path, which is what "show everything
-- paid" needs.
-- =============================================================

alter table public.cash_payout_lines
  add column if not exists cover_driver_id uuid
    references public.cover_drivers(id) on delete set null;

-- The existing cash_payout_lines_unique (payout_id, employee_id) is KEPT, not
-- replaced. Two reasons:
--
--   1. Dropping it would break the currently-deployed code the instant this
--      migration ran. The old generatePayout upserts with
--      `onConflict: "payout_id,employee_id"`, and Postgres will not accept a
--      PARTIAL index as an ON CONFLICT target — payout generation would fail
--      with "no unique or exclusion constraint matching the ON CONFLICT
--      specification" until the new build shipped. Keeping it means this file
--      is safe to run before deploying.
--   2. It costs nothing to keep. Cover driver lines have employee_id null, and
--      Postgres treats nulls as distinct, so they never collide with it.
--
-- Cover driver lines are deduplicated by their own partial index instead.
create unique index if not exists cash_payout_lines_cover_driver_unique
  on public.cash_payout_lines (payout_id, cover_driver_id)
  where cover_driver_id is not null;

-- Exactly one of the two must be set. Without this a line could reference both
-- (ambiguous on the sheet) or neither (an orphan nobody can be paid against).
--
-- Deliberately left NOT VALID and NOT validated. employee_id is
-- `on delete set null`, so deleting an employee leaves historical lines with
-- both ids null — real, already-paid records that must not block this
-- migration. NOT VALID still enforces the rule on every future insert and
-- update, which is the part that matters; it only skips re-checking rows
-- written before the rule existed.
alter table public.cash_payout_lines
  drop constraint if exists cash_payout_lines_one_payee;
alter table public.cash_payout_lines
  add constraint cash_payout_lines_one_payee
  check (
    (employee_id is not null and cover_driver_id is null)
    or (employee_id is null and cover_driver_id is not null)
  ) not valid;

comment on column public.cash_payout_lines.cover_driver_id is
  'Set instead of employee_id when this line pays a cover driver. Exactly one of the two is non-null.';
