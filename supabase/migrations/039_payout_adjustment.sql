-- =============================================================
-- Migration 039 — A manual +/− adjustment on the Tuesday payout
--
-- Run AFTER 038. ADDITIVE ONLY — two new columns with defaults that make every
-- existing row read exactly as it does today (0 adjustment, no reason). Safe to
-- run BEFORE the code ships (the rule migration 027 nearly broke, Update 65).
--
-- THE PROBLEM
-- The Pre-Payment Summary was closed: every figure on it was derived, so cash
-- that entered or left the pot for a reason the system doesn't model had
-- nowhere to go. The manager's only options were to mis-record an envelope
-- (which corrupts the Vita Mojo reconciliation and the discrepancy alerts) or
-- to draw the wrong amount from the Post Office and carry the error forward as
-- next week's opening balance.
--
-- WHERE IT LANDS IN THE MATHS
-- Deliberately NOT folded into actual_cash_available, which stays exactly what
-- it says: opening balance + envelopes collected + supermarket float. Two
-- reasons. First, PrePaymentView reconstructs the supermarket float from a
-- locked payout as (actual − collected − opening), and an adjustment hidden
-- inside `actual` would be silently misreported as supermarket money. Second,
-- an adjustment is not cash the reconciliation knows about — keeping it on its
-- own line is what makes the sheet auditable.
--
-- So it applies one step later, at the settle:
--
--   diff             = actual_cash_available + adjustment − grand_total_wages
--   post_office_draw = diff < 0 ? −diff : 0
--   surplus          = diff > 0 ?  diff : 0
--
-- A POSITIVE adjustment is cash added to the pot: it shrinks the Post Office
-- draw, or grows the surplus carried into next week. A NEGATIVE one is cash
-- taken out, and does the opposite.
--
-- The columns live on cash_payouts because that table is already keyed
-- uniquely on (store_id, week_start_date) and is already the locked snapshot:
-- confirming a payout freezes the adjustment with everything else, and the
-- surplus it carries forward is the adjusted figure. Nothing extra to keep in
-- step.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

alter table public.cash_payouts
  add column if not exists adjustment_amount numeric(10,2) not null default 0,
  add column if not exists adjustment_reason text;

comment on column public.cash_payouts.adjustment_amount is
  'Manual cash adjustment for this store-week, SIGNED: positive = cash added to the pot, negative = cash taken out. Applied at the settle (diff = actual_cash_available + adjustment - grand_total_wages), never folded into actual_cash_available. Frozen when the payout is confirmed.';
comment on column public.cash_payouts.adjustment_reason is
  'Why the adjustment was made. Required by the application whenever adjustment_amount is non-zero — an unexplained movement of cash is the thing this column exists to prevent.';

-- A corruption guard, not a business rule: the application bounds this far
-- tighter (±£10,000) with a friendly message. This only stops a runaway write.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cash_payouts_adjustment_sane'
  ) then
    alter table public.cash_payouts
      add constraint cash_payouts_adjustment_sane
      check (adjustment_amount >= -1000000 and adjustment_amount <= 1000000);
  end if;
end $$;

-- =============================================================
-- No RLS change: cash_payouts_modify is already
-- `for all ... using (can_access_store(store_id))`, so a manager can write
-- these columns for their own store exactly as they already confirm a payout.
--
-- Backfill: none. Every existing payout defaults to a zero adjustment, so no
-- historical total, surplus or Post Office draw moves by a penny when this runs.
-- =============================================================
