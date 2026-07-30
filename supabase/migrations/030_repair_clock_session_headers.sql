-- =============================================================
-- Migration 030 — Repair day headers derived in the wrong order
--
-- Run AFTER 029. Idempotent and safe to re-run at any time: it recomputes
-- derived values from clock_sessions, which are the source of truth.
--
-- THE BUG THIS REPAIRS
-- 029 shipped with recomputeDayHeader() deriving a day's bounds from `seq`
-- order: first session = day start, last session = day end. But `seq` is
-- INSERTION order, not clock order. A manager recording a forgotten day who
-- entered the evening shift before the morning one produced seq 1 = 17:00–21:00
-- and seq 2 = 09:00–13:00 — so the day was stamped clock_in_at 17:00 and
-- clock_out_at 13:00, an out BEFORE the in. Any auto-created rota cell was
-- stamped from the same wrong bounds.
--
-- worked_hours was never affected (a sum doesn't care about order), so no pay
-- was wrong — but the day's displayed window was nonsense.
--
-- The code now derives bounds as MIN(clock_in_at) / MAX(clock_out_at). This
-- fixes the rows already written.
-- =============================================================

with agg as (
  select
    cs.clock_event_id,
    min(cs.clock_in_at)                                       as first_in,
    max(cs.clock_out_at)                                      as last_out,
    count(*)::int                                             as n,
    count(*) filter (where cs.clock_out_at is not null)        as completed,
    count(*) filter (where cs.clock_out_at is null)            as still_open,
    round(
      coalesce(
        sum(extract(epoch from (cs.clock_out_at - cs.clock_in_at)) / 3600.0)
          filter (where cs.clock_out_at is not null),
        0
      )::numeric,
      2
    )                                                          as hours
  from public.clock_sessions cs
  group by cs.clock_event_id
)
update public.clock_events ce
set
  clock_in_at   = agg.first_in,
  -- A day with any shift still open reads as open everywhere, exactly as the
  -- application maintains it.
  clock_out_at  = case when agg.still_open > 0 then null else agg.last_out end,
  worked_hours  = case when agg.completed > 0 then agg.hours else null end,
  session_count = agg.n
from agg
where agg.clock_event_id = ce.id
  and (
    ce.clock_in_at   is distinct from agg.first_in
    or ce.clock_out_at is distinct from (case when agg.still_open > 0 then null else agg.last_out end)
    or ce.worked_hours is distinct from (case when agg.completed > 0 then agg.hours else null end)
    or ce.session_count is distinct from agg.n
  );

-- Re-stamp the rota cells the system created from a clock-in. Manager-booked
-- cells are left alone: their times are a plan, not a record of attendance.
with agg as (
  select
    cs.clock_event_id,
    min(cs.clock_in_at)                                        as first_in,
    max(cs.clock_out_at)                                       as last_out,
    count(*) filter (where cs.clock_out_at is null)             as still_open,
    round(
      coalesce(
        sum(extract(epoch from (cs.clock_out_at - cs.clock_in_at)) / 3600.0)
          filter (where cs.clock_out_at is not null),
        0
      )::numeric,
      2
    )                                                           as hours
  from public.clock_sessions cs
  group by cs.clock_event_id
)
update public.rota_shifts rs
set
  -- rota_shifts.start_time/end_time are `time`, and shift times are UK wall
  -- clock: `at time zone 'Europe/London'` converts the timestamptz to London
  -- local time, then date_trunc drops the seconds so these match the HH:MM the
  -- application writes.
  start_time      = date_trunc('minute', agg.first_in at time zone 'Europe/London')::time,
  end_time        = date_trunc('minute', agg.last_out at time zone 'Europe/London')::time,
  scheduled_hours = agg.hours
from agg
join public.clock_events ce on ce.id = agg.clock_event_id
where rs.id = ce.shift_id
  and rs.manager_notes = 'Auto-created from clock-in'
  and agg.still_open = 0
  and agg.last_out is not null;
