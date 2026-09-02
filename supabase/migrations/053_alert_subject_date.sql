-- =============================================================
-- 053: Give date-scoped alerts a date, so they stop overwriting each other.
--
-- upsertAlert keys an open alert on (alert_type, store_id, employee_id,
-- shift_id). Three types carry no employee and no shift, so every date
-- collapsed onto ONE row per store: the second unresolved discrepancy of the
-- week rewrote the first, a still-missing entry from yesterday was silently
-- restamped with today's date, and a driver's unassigned deliveries in four
-- different weeks read as one. Managers cleared the single visible row and
-- believed they were straight.
--
-- `subject_date` is the day (or week) the alert is ABOUT, as opposed to
-- created_at, which is when it was noticed. Null for the types whose subject is
-- a current state rather than a date -- wage_variance, min_wage_violation,
-- delivery_payout_high -- and for the day-scoped clock alerts, which are
-- already separated by shift_id.
-- =============================================================

alter table public.alerts
  add column if not exists subject_date date;

-- The dedup lookup and both sweeps filter on type + resolved and then narrow by
-- date, so lead with the two that are always present.
create index if not exists alerts_type_subject_date_idx
  on public.alerts (alert_type, resolved, subject_date);

-- Backfill the collapsed rows from the payload they already carry, so an open
-- alert keeps its identity instead of being orphaned by the new key.
update public.alerts
set    subject_date = (payload ->> 'date')::date
where  subject_date is null
and    alert_type in ('missing_daily_entry', 'unresolved_discrepancy')
and    payload ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$';

update public.alerts
set    subject_date = (payload ->> 'week')::date
where  subject_date is null
and    alert_type = 'delivery_unassigned'
and    payload ->> 'week' ~ '^\d{4}-\d{2}-\d{2}$';

-- Anything of these types still undated predates the payload that would say
-- which day it meant. It can never match the new key and can never be swept by
-- a date-bounded sweep, so it would sit open forever beside a correctly dated
-- replacement. Close it and let the next scan raise the real ones.
update public.alerts
set    resolved = true,
       resolved_at = now(),
       resolution_note = coalesce(
         resolution_note,
         'Auto-resolved: superseded by date-scoped alerts (migration 053)'
       )
where  resolved = false
and    subject_date is null
and    alert_type in ('missing_daily_entry', 'unresolved_discrepancy', 'delivery_unassigned');
