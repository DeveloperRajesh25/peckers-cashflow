-- =============================================================
-- 055: Record WHEN an alert was last rewritten, and re-key the Post Office
-- draw onto the pay week it is about.
--
-- upsertAlert updates an open alert in place, so a row's figures can be hours
-- or days newer than the `created_at` the board prints beside them. The Post
-- Office draw made that visible: it was recomputed only on Mondays and
-- Tuesdays, so by Wednesday the board showed a draw the payout sheet no longer
-- agreed with, stamped with the date it was first raised. `updated_at` is what
-- lets the board say when the number itself was last true.
--
-- The draw also carried no subject_date, so ONE row per store was reused for
-- every pay week that ever needed a draw. Adding the date (the pay week's
-- Monday) changes its dedup key, which leaves any currently-open undated row
-- unmatchable by the new key -- exactly the situation 053 closed rows for.
-- =============================================================

alter table public.alerts
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_alerts_updated_at on public.alerts;
create trigger set_alerts_updated_at
  before update on public.alerts
  for each row execute function public.set_updated_at();

-- An open, undated post_office_draw predates the pay-week key and can never be
-- matched or refreshed again. Close it; the next scan raises the dated one.
update public.alerts
set    resolved = true,
       resolved_at = now(),
       resolution_note = coalesce(
         resolution_note,
         'Auto-resolved: superseded by pay-week-scoped draw alerts (migration 055)'
       )
where  resolved = false
and    subject_date is null
and    alert_type = 'post_office_draw';
