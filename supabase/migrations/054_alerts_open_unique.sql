-- =============================================================
-- 054: Make the open-alert dedup a database rule, not just an app convention.
--
-- upsertAlert dedups by reading, then inserting if it found nothing. The scan
-- runs on every clock-in, every clock-out and every cash-flow or payout write,
-- so two of them overlap routinely: both read "no existing", both insert, and
-- the board grows a pair. schema.sql said dedup was app-side and no index
-- backed it, which also made the "duplicate" check in upsertAlert's error
-- handler dead code -- Postgres had no constraint to violate.
--
-- The key matches upsertAlert's exactly, including subject_date from 053.
-- NULLs are folded to sentinels rather than relying on NULLS NOT DISTINCT
-- (PG15+): a plain unique index treats NULLs as distinct, so without this every
-- store-level alert -- no employee, no shift -- would slip past it, which is
-- the whole set of rows that needs it most.
--
-- The sentinel UUID here is NOT the bug migration 052 fixed. That one compared
-- a sentinel against a NULL column with `eq` and never matched. coalesce
-- applies to both sides, so equal keys collide as intended.
-- =============================================================

-- Collapse anything the race left behind, on the FULL key this time (052 ran
-- before subject_date existed). A unique index cannot be created over
-- duplicates, so this has to come first.
update public.alerts a
set    resolved = true,
       resolved_at = now(),
       resolution_note = coalesce(a.resolution_note, 'Auto-resolved: duplicate of a newer open alert (migration 054)')
where  a.resolved = false
and    exists (
         select 1
         from   public.alerts b
         where  b.resolved = false
         and    b.alert_type = a.alert_type
         and    b.store_id     is not distinct from a.store_id
         and    b.employee_id  is not distinct from a.employee_id
         and    b.shift_id     is not distinct from a.shift_id
         and    b.subject_date is not distinct from a.subject_date
         and    (b.created_at, b.id) > (a.created_at, a.id)
       );

create unique index if not exists alerts_open_unique
  on public.alerts (
    alert_type,
    coalesce(store_id,    '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(shift_id,    '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(subject_date, '0001-01-01'::date)
  )
  where resolved = false;

-- NOTE for whoever reaches for ON CONFLICT next: Postgres will not accept a
-- partial index as a conflict target, and supabase-js cannot express the
-- predicate anyway (see Update 65). The app handles the collision by catching
-- the duplicate-key error and updating the winning row instead.
