-- 041: cover_driver_hours keeps the MS/ML breakdown
--
-- The approval snapshot had only short_deliveries / long_deliveries, so
-- approveCoverDriverDay folded the extras in (2 SD + 2 MS became 4 SD). Pay was
-- right — extras bill at the short/long rate — but the breakdown was destroyed,
-- and Daily Approval read the folded total back as the base count.
--
-- Employees and managers already snapshot the split (approved_extra_short_deliveries,
-- migration 035); cover drivers were missed.
--
-- After this, short_deliveries means THE NORMAL ROUND, matching
-- cover_driver_clock_events.short_deliveries_count. Existing rows hold the folded
-- total with extras 0, which pays identically — their breakdown is not
-- recoverable and is deliberately left alone.

alter table public.cover_driver_hours
  add column if not exists extra_short_deliveries integer not null default 0,
  add column if not exists extra_long_deliveries  integer not null default 0;

alter table public.cover_driver_hours
  drop constraint if exists cover_driver_hours_extra_non_negative;
alter table public.cover_driver_hours
  add constraint cover_driver_hours_extra_non_negative
  check (extra_short_deliveries >= 0 and extra_long_deliveries >= 0);

comment on column public.cover_driver_hours.extra_short_deliveries is
  'MS — short drops beyond the normal round, snapshotted at approval. Paid at short_rate_snapshot.';
comment on column public.cover_driver_hours.extra_long_deliveries is
  'ML — long drops beyond the normal round, snapshotted at approval. Paid at long_rate_snapshot.';

-- Pay now bills base + extra at the same per-type rate. Identical output for
-- every existing row (extras default 0), so this is safe to run before the code
-- that writes the new columns ships.
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
  h.extra_short_deliveries,
  h.extra_long_deliveries,
  h.short_rate_snapshot,
  h.long_rate_snapshot,
  -- Cash only: no bank split, every hour is paid cash.
  h.total_hours_worked * h.hourly_rate_snapshot            as hours_pay,
  (h.short_deliveries + h.extra_short_deliveries)
    * coalesce(h.short_rate_snapshot, 0)                   as short_delivery_pay,
  (h.long_deliveries + h.extra_long_deliveries)
    * coalesce(h.long_rate_snapshot, 0)                    as long_delivery_pay,
  h.total_hours_worked * h.hourly_rate_snapshot
    + (h.short_deliveries + h.extra_short_deliveries) * coalesce(h.short_rate_snapshot, 0)
    + (h.long_deliveries  + h.extra_long_deliveries)  * coalesce(h.long_rate_snapshot, 0) as total_pay,
  h.notes,
  h.approved,
  h.approved_at,
  h.source,
  h.created_at
from public.cover_driver_hours h
join public.cover_drivers d on d.id = h.cover_driver_id;

grant select on public.cover_driver_hours_computed to authenticated;
