-- =============================================================
-- Manager multiple shifts (Update 76 / migration 031) — verify + clean up
--
-- Run these in the Supabase SQL editor against whichever project you tested on.
-- Sections 1-4 are READ ONLY. Section 5 deletes, and is commented out on
-- purpose — read its notes before uncommenting.
--
-- Nothing here touches employees, cover drivers, store coordinates, or any
-- money. Manager attendance feeds no payroll: a manager is on a fixed daily
-- wage that turns on merely having clocked in.
-- =============================================================


-- =============================================================
-- 1. Which login am I testing with?
--    Copy the id — the queries below use it.
-- =============================================================
select id, name, username, email, role, store_id
from public.allowed_users
where role = 'manager'
order by name;


-- =============================================================
-- 2. Today's shifts for every manager, header beside its sessions.
--
--    After clocking in → out → in again you should see ONE header row with
--    session_count = 2, clock_out_at NULL (a shift is open), and worked_hours
--    holding only the FIRST shift's hours.
-- =============================================================
select
  au.name                                   as manager,
  mce.event_date,
  mce.clock_in_at                           as header_in,
  mce.clock_out_at                          as header_out,
  mce.worked_hours,
  mce.session_count,
  mce.auto_clocked_out,
  mcs.seq,
  mcs.clock_in_at                           as shift_in,
  mcs.clock_out_at                          as shift_out,
  round(
    extract(epoch from (mcs.clock_out_at - mcs.clock_in_at)) / 3600.0
  )::numeric(6,2)                           as shift_hours,
  mcs.auto_clocked_out                      as shift_auto_closed,
  st.name                                   as store
from public.manager_clock_events mce
join public.allowed_users au on au.id = mce.manager_id
left join public.manager_clock_sessions mcs on mcs.clock_event_id = mce.id
left join public.stores st on st.id = mcs.store_id
where mce.event_date >= current_date - 7
order by mce.event_date desc, au.name, mcs.clock_in_at;


-- =============================================================
-- 3. THE INVARIANT CHECK — does every header agree with its sessions?
--
--    recomputeManagerDayHeader is the only writer of those four columns, so
--    this must return ZERO ROWS. Anything listed means a header drifted from
--    the shifts beneath it.
--
--    Rows with session_count = 0 are skipped: those are pre-031 days that
--    migration 031 deliberately left without sessions, and readers fall back
--    to clock_out_at - clock_in_at for them.
-- =============================================================
with derived as (
  select
    mcs.clock_event_id,
    min(mcs.clock_in_at)                                as first_in,
    max(mcs.clock_out_at)                               as last_out,
    count(*)::int                                       as n,
    count(*) filter (where mcs.clock_out_at is null)    as still_open,
    round(
      coalesce(
        sum(extract(epoch from (mcs.clock_out_at - mcs.clock_in_at)) / 3600.0)
          filter (where mcs.clock_out_at is not null),
        0
      )::numeric,
      2
    )                                                   as hours,
    count(*) filter (where mcs.clock_out_at is not null) as completed
  from public.manager_clock_sessions mcs
  group by mcs.clock_event_id
)
select
  au.name          as manager,
  mce.event_date,
  mce.clock_in_at  as header_in,   d.first_in                                        as should_be_in,
  mce.clock_out_at as header_out,  case when d.still_open > 0 then null else d.last_out end as should_be_out,
  mce.worked_hours as header_hours, case when d.completed > 0 then d.hours else null end   as should_be_hours,
  mce.session_count as header_count, d.n                                             as should_be_count
from public.manager_clock_events mce
join derived d on d.clock_event_id = mce.id
join public.allowed_users au on au.id = mce.manager_id
where mce.clock_in_at   is distinct from d.first_in
   or mce.clock_out_at  is distinct from (case when d.still_open > 0 then null else d.last_out end)
   or mce.worked_hours  is distinct from (case when d.completed  > 0 then d.hours    else null end)
   or mce.session_count is distinct from d.n;
-- Expect: 0 rows.
-- If any appear, migration 030's repair block rewritten for managers will fix
-- them — or simply clock in and out once more, which recomputes the header.


-- =============================================================
-- 4. Nobody should ever hold two open shifts at once.
--    manager_clock_sessions_one_open enforces this, so it is a belt-and-braces
--    check that the index actually got created.
-- =============================================================
select manager_id, count(*) as open_shifts
from public.manager_clock_sessions
where clock_out_at is null
group by manager_id
having count(*) > 1;
-- Expect: 0 rows.

select indexname
from pg_indexes
where tablename = 'manager_clock_sessions'
order by indexname;
-- Expect to see manager_clock_sessions_one_open in the list.


-- =============================================================
-- 5. CLEANUP — remove the test day(s) you created.
--
--    Deleting the header cascades to its sessions (on delete cascade), so one
--    delete clears the whole day. Manager clock rows are referenced by nothing
--    else — no payout line, no approval row, no rollup — so this leaves no
--    dangling references.
--
--    SAFETY: run the SELECT first and confirm it lists ONLY the days you
--    created by hand. Then uncomment the DELETE.
--
--    Replace <MANAGER_ID> with the id from section 1 and adjust the dates.
-- =============================================================

-- select au.name, mce.event_date, mce.session_count, mce.worked_hours
-- from public.manager_clock_events mce
-- join public.allowed_users au on au.id = mce.manager_id
-- where mce.manager_id = '<MANAGER_ID>'
--   and mce.event_date between '2026-07-31' and '2026-07-31';

-- delete from public.manager_clock_events
-- where manager_id = '<MANAGER_ID>'
--   and event_date between '2026-07-31' and '2026-07-31';

-- The audit trail is deliberately NOT deleted — manager_clock_in /
-- manager_clock_out rows in audit_log are a record of what happened, and
-- nothing reads them back into a screen. Remove them only if you want the log
-- tidy:
-- delete from public.audit_log
-- where action in ('manager_clock_in', 'manager_clock_out')
--   and created_at >= '2026-07-31';
