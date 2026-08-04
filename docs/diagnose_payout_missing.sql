-- =============================================================
-- Why isn't an approved employee on the Tuesday payout?
--
-- Run in the Supabase SQL editor. Read-only — it changes nothing.
--
-- The payout screen for the week starting MONDAY 03/08/2026 pays work done
-- 27/07/2026 – 02/08/2026. Wages run a week in arrears, so work done ON
-- Monday 03/08 is paid on NEXT Tuesday's sheet (week starting 10/08).
-- Change :pay_start / :pay_end below if you're looking at a different week.
-- =============================================================

-- -------------------------------------------------------------
-- 1. What state is each clocked day actually in?
--
--    approved_hours NULL  → not signed off (or the approval didn't land)
--    approved_hours > 0   → payable, so the reason is in query 2
-- -------------------------------------------------------------
select
  e.name                       as employee,
  st.name                      as store_worked,
  ce.event_date,
  ce.worked_hours              as clocked_hrs,
  ce.approved_hours            as approved_hrs,
  ce.hours_approved            as all_shifts_signed_off,
  ce.session_count             as shifts,
  ce.approved_session_count    as shifts_approved,
  case
    when ce.clock_out_at is null then 'STILL CLOCKED IN — cannot be approved yet'
    when ce.approved_hours is null then 'NOT APPROVED — no pay'
    when ce.approved_session_count < ce.session_count then 'PARTLY approved'
    else 'approved'
  end                          as verdict
from public.clock_events ce
join public.employees e on e.id = ce.employee_id
left join public.stores st on st.id = ce.store_id
where ce.event_date between date '2026-07-27' and date '2026-08-02'
order by e.name, ce.event_date;


-- -------------------------------------------------------------
-- 2. For everyone WITH approved hours, does that produce a cash line?
--
--    Two rules stop an approved employee reaching the sheet, both by design:
--      a) no cash rate      → every hour is NI/bank (PAYE), never on this sheet
--      b) home store, and   → the first `bank_weekly_hours_limit` hours (20 by
--         total <= limit       default) are NI. Under the limit = £0 cash, so
--                              a non-driver produces NO LINE AT ALL.
--    Drivers still appear if they have approved deliveries.
-- -------------------------------------------------------------
with weekly as (
  select
    ce.employee_id,
    ce.store_id,
    sum(coalesce(ce.approved_hours, 0))                     as approved_hrs,
    sum(coalesce(ce.approved_short_deliveries_count, 0)
      + coalesce(ce.approved_long_deliveries_count, 0)
      + coalesce(ce.approved_extra_short_deliveries, 0)
      + coalesce(ce.approved_extra_long_deliveries, 0))     as approved_drops
  from public.clock_events ce
  where ce.event_date between date '2026-07-27' and date '2026-08-02'
  group by ce.employee_id, ce.store_id
)
select
  e.name                                    as employee,
  st.name                                   as store_worked,
  (w.store_id = e.store_id)                 as is_home_store,
  w.approved_hrs,
  e.hourly_cash_rate,
  e.bank_weekly_hours_limit                 as ni_limit,
  w.approved_drops,
  case
    when e.hourly_cash_rate is null or e.hourly_cash_rate <= 0 then 0
    when w.store_id = e.store_id
      then greatest(0, w.approved_hrs - coalesce(e.bank_weekly_hours_limit, 20))
    else w.approved_hrs
  end                                       as cash_hours_payable,
  case
    when w.approved_hrs = 0 then 'nothing approved this week'
    when e.hourly_cash_rate is null or e.hourly_cash_rate <= 0
      then 'NO CASH RATE — all hours are NI/bank, correctly not on this sheet'
    when w.store_id = e.store_id
     and w.approved_hrs <= coalesce(e.bank_weekly_hours_limit, 20)
     and w.approved_drops = 0
      then 'UNDER THE ' || coalesce(e.bank_weekly_hours_limit, 20)
           || 'h NI LIMIT at home store — all NI, no cash line (by design)'
    else 'should appear on the payout'
  end                                       as why
from weekly w
join public.employees e on e.id = w.employee_id
left join public.stores st on st.id = w.store_id
order by e.name;
