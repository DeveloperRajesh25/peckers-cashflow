-- =============================================================
-- 040 — Separate MISC (extra) delivery rates for MANAGERS
--
-- Until now a misc drop (MS / ML — beyond the normal round) was paid at the
-- same per-drop rate as the normal round, for every payee type. Managers now
-- get their own pair of rates so an admin can price the extras differently.
--
-- MANAGERS ONLY. Employees and cover drivers deliberately keep the single pair
-- of rates — their misc drops still pay at the base rate.
--
-- Null is not "free": it means "use this manager's base rate", which itself
-- falls back to the default petrol rate. So an admin who never fills these in
-- gets exactly the maths that ran before this migration, and no already-approved
-- week can change value on deploy.
-- ======================================================

alter table public.allowed_users
  add column if not exists extra_short_delivery_rate numeric(8,2),
  add column if not exists extra_long_delivery_rate  numeric(8,2);

comment on column public.allowed_users.extra_short_delivery_rate is
  'Per-drop rate (£) for a manager''s MISC SHORT deliveries (MS). Null = fall back to short_delivery_rate, then to the default petrol rate. Only meaningful for role=manager.';
comment on column public.allowed_users.extra_long_delivery_rate is
  'Per-drop rate (£) for a manager''s MISC LONG deliveries (ML). Null = fall back to long_delivery_rate, then to the default petrol rate. Only meaningful for role=manager.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'allowed_users_extra_delivery_rates_non_negative'
  ) then
    alter table public.allowed_users
      add constraint allowed_users_extra_delivery_rates_non_negative
      check (
        coalesce(extra_short_delivery_rate, 0) >= 0
        and coalesce(extra_long_delivery_rate, 0) >= 0
      );
  end if;
end $$;

-- -------------------------------------------------------------
-- The payout line snapshots the rate it was priced at, the same reason cover
-- driver approvals snapshot theirs: a rate change next month must not restate
-- a week already paid. Without these, a manager line priced at a distinct misc
-- rate could not be re-derived from its own row.
--
-- Null on an existing row means "misc was paid at the base rate", which is
-- exactly what every line written before this migration did.
-- -------------------------------------------------------------
alter table public.cash_payout_lines
  add column if not exists short_misc_rate numeric(8,2),
  add column if not exists long_misc_rate  numeric(8,2);

comment on column public.cash_payout_lines.short_misc_rate is
  'Rate (£) each MS drop on this line was priced at. Null = the line''s short_delivery_rate was used.';
comment on column public.cash_payout_lines.long_misc_rate is
  'Rate (£) each ML drop on this line was priced at. Null = the line''s long_delivery_rate was used.';
