-- =============================================================
-- 052: Collapse duplicate open alerts left behind by the broken dedup key.
--
-- upsertAlert matched a NULL employee_id/shift_id with `eq` against a sentinel
-- UUID, which never matches NULL in SQL. Every store-level alert and every
-- employee alert without a rota row was therefore re-inserted on each scan --
-- and the scan runs on every clock-in and clock-out. Stores accumulated
-- hundreds of identical open rows.
--
-- Keeps the newest open row per (alert_type, store_id, employee_id, shift_id)
-- and resolves the rest. Idempotent: re-running finds nothing left to collapse.
-- =============================================================

update public.alerts a
set    resolved = true,
       resolved_at = now(),
       resolution_note = coalesce(a.resolution_note, 'Auto-resolved: duplicate of a newer open alert (migration 052)')
where  a.resolved = false
and    exists (
         select 1
         from   public.alerts b
         where  b.resolved = false
         and    b.alert_type = a.alert_type
         and    b.store_id is not distinct from a.store_id
         and    b.employee_id is not distinct from a.employee_id
         and    b.shift_id is not distinct from a.shift_id
         and    (b.created_at, b.id) > (a.created_at, a.id)
       );
