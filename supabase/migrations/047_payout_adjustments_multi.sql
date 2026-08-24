-- =============================================================
-- Migration 047 — MANY manual adjustments per payout week
--
-- Run AFTER 046, and BEFORE the code that reads it ships (it is purely
-- additive, so the currently deployed code keeps working the moment it lands —
-- the rule migration 027 nearly broke, Update 65).
--
-- THE PROBLEM
-- Migration 039 gave the Tuesday sheet ONE adjustment: two columns on
-- cash_payouts. A week rarely has one movement — a supplier paid in cash, a
-- float topped up and a till shortage are three separate facts, and squeezing
-- them into a single amount loses every reason but the last one typed. The
-- manager's only options were to overwrite the previous adjustment or to add
-- the numbers together in their head and write one vague reason.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOESN'T
-- The settle maths is untouched. cash_payouts.adjustment_amount stays exactly
-- what it always was — the SIGNED total applied at the settle — and is now
-- kept as the ROLL-UP of the child rows below, written by the application on
-- every add/edit/delete. adjustment_reason becomes the joined summary of the
-- child reasons. Everything that already reads those two columns (the alert
-- forecast, Payout History, the frozen snapshot on a confirmed payout) keeps
-- reading them and keeps getting the same answer.
--
--   diff             = actual_cash_available - SUM(adjustments) - grand_total_wages
--   post_office_draw = diff < 0 ? -diff : 0
--   surplus          = diff > 0 ?  diff : 0
--
-- A POSITIVE adjustment is cash taken OUT of the pot (it grows the Post Office
-- draw), a NEGATIVE one is cash added. Unchanged from 039.
--
-- Child rows hang off cash_payouts by id and cascade with it, exactly like
-- cash_payout_lines: confirming a payout freezes the roll-up with the rest of
-- the header, and deleting a payout takes its adjustments with it.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

create table if not exists public.cash_payout_adjustments (
  id              uuid primary key default gen_random_uuid(),
  payout_id       uuid not null references public.cash_payouts(id) on delete cascade,
  -- SIGNED, same convention as cash_payouts.adjustment_amount.
  amount          numeric(10,2) not null,
  -- Not null: an unexplained movement of cash is the thing this table exists to
  -- prevent. The application also refuses a blank one.
  reason          text not null,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists cash_payout_adjustments_payout_idx
  on public.cash_payout_adjustments (payout_id);

comment on table public.cash_payout_adjustments is
  'One manual cash movement on a store-week payout sheet. The SUM of these rows is mirrored onto cash_payouts.adjustment_amount, which is what the settle maths reads — never re-derive the total anywhere else.';
comment on column public.cash_payout_adjustments.amount is
  'SIGNED: positive = cash taken out of the pot, negative = cash added. Applied at the settle via the roll-up on cash_payouts.adjustment_amount, never folded into actual_cash_available.';

-- A corruption guard, not a business rule: the application bounds each entry at
-- ±£10,000 with a friendly message. This only stops a runaway write.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cash_payout_adjustments_sane'
  ) then
    alter table public.cash_payout_adjustments
      add constraint cash_payout_adjustments_sane
      check (amount >= -1000000 and amount <= 1000000);
  end if;
end $$;

drop trigger if exists set_cash_payout_adjustments_updated_at on public.cash_payout_adjustments;
create trigger set_cash_payout_adjustments_updated_at
  before update on public.cash_payout_adjustments
  for each row execute function public.set_updated_at();

-- ----- RLS: scoped through the parent payout's store, like cash_payout_lines -----
alter table public.cash_payout_adjustments enable row level security;

drop policy if exists "cash_payout_adjustments_select" on public.cash_payout_adjustments;
drop policy if exists "cash_payout_adjustments_modify" on public.cash_payout_adjustments;

create policy "cash_payout_adjustments_select" on public.cash_payout_adjustments
  for select to authenticated
  using (
    exists (
      select 1 from public.cash_payouts p
      where p.id = payout_id and public.can_access_store(p.store_id)
    )
  );

create policy "cash_payout_adjustments_modify" on public.cash_payout_adjustments
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
-- Backfill: every existing single adjustment becomes the week's first child row,
-- so no sheet changes by a penny and the one movement already recorded stays
-- editable on the new screen instead of becoming an untouchable header figure.
-- Guarded on the payout having no child rows yet, so re-running is a no-op.
-- =============================================================
insert into public.cash_payout_adjustments (payout_id, amount, reason)
select p.id, p.adjustment_amount, coalesce(nullif(btrim(p.adjustment_reason), ''), 'Adjustment')
from public.cash_payouts p
where p.adjustment_amount <> 0
  and not exists (
    select 1 from public.cash_payout_adjustments a where a.payout_id = p.id
  );
