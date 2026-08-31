-- =============================================================
-- Migration 049 — VAT entered on a weekly expense line
--
-- Run AFTER 048. ADDITIVE ONLY: one new nullable column. Safe to run before the
-- code ships — nothing currently deployed reads it.
--
-- The expenses tab derived VAT as 20% of the amount and showed it read-only.
-- That is wrong often enough to matter: food is zero-rated, a supplier may not
-- be VAT registered, and a receipt states its own figure. The column is
-- NULLABLE and null keeps the old behaviour — the standard rate on the amount —
-- so no existing row changes meaning and a manager only types where it differs.
--
-- Still RECORD ONLY, like the rest of the expenses sheet: no P&L formula reads
-- it (see the section comment in 048).
--
-- Idempotent.
-- =============================================================

alter table public.weekly_report_lines
  add column if not exists vat_amount numeric(12,2);

comment on column public.weekly_report_lines.vat_amount is
  'VAT as entered on an expense line. Null = fall back to the standard rate on `amount`. Record only — no P&L formula reads it.';
