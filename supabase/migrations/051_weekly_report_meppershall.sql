-- =============================================================
-- Migration 051 — Weekly Report: the Meppershall credit
--
-- Run AFTER 050. ADDITIVE ONLY: two new nullable columns. Nothing currently
-- deployed reads either, so this is safe to run before the code ships.
--
-- WHY
-- Hitchin supplies Meppershall, and that stock leaves the store exactly the way
-- a transfer to Stevenage does — it is a cost the week carries but not a cost
-- of the week's own sales. It therefore joins the same credit side of gross
-- margin as the COGS transfer and Fillings and Samosas:
--
--   Gross Margin = Net Sales - COGS + COGS transfer + Fillings and Samosas
--                  + Meppershall
--
-- WHY IT IS A HEADER SCALAR
-- It is one standing weekly figure (£350), not a sheet of lines. Same shape as
-- packaging_costs and marketing, so it lives beside them rather than becoming
-- an eleventh section nobody would ever type more than one row into.
--
-- WHY THE DEFAULT LIVES ON `stores`
-- Only Hitchin supplies Meppershall. Defaulting the column to 350 for everyone
-- would silently credit Stevenage £350 a week it never earned, and hard-coding
-- a store code in TypeScript is the mapping mistake migration 048 avoided with
-- vm_store_name. The default is data: a store that starts supplying Meppershall
-- gets a row updated, not a deploy.
--
-- Idempotent.
-- =============================================================

alter table public.stores
  add column if not exists meppershall_default numeric(10,2);

comment on column public.stores.meppershall_default is
  'Standing weekly Meppershall credit for this store, seeded onto each new weekly report. Null = this store does not supply Meppershall and the field is hidden on its report.';

update public.stores set meppershall_default = 350
  where code = 'hitchin' and meppershall_default is null;

alter table public.weekly_reports
  add column if not exists meppershall numeric(10,2);

comment on column public.weekly_reports.meppershall is
  'Credited back into gross margin alongside the COGS transfer — stock that left for Meppershall is not a cost of this week''s sales. Seeded from stores.meppershall_default; null on a store that does not supply it.';

-- Existing DRAFTS get the standing figure. Locked and sent reports are left
-- alone: their figures are frozen in weekly_reports.snapshot and restating one
-- already mailed out is exactly what the snapshot exists to prevent.
update public.weekly_reports r
   set meppershall = s.meppershall_default
  from public.stores s
 where s.id = r.store_id
   and r.status = 'draft'
   and r.meppershall is null
   and s.meppershall_default is not null;
