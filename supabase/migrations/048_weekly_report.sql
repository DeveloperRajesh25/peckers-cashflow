-- =============================================================
-- Migration 048 — Weekly Report (the manager's Excel workbook, in the app)
--
-- Run AFTER 047. ADDITIVE ONLY: three new tables and one new nullable column on
-- `stores`. Nothing currently deployed reads or writes any of it, so this is
-- safe to run BEFORE the code ships (the rule migration 027 nearly broke — see
-- Update 65).
--
-- THE PROBLEM
-- The weekly P&L lives in a spreadsheet that is duplicated every Monday. Ten
-- sheets, but only THREE shapes, which is why this collapses into a small
-- schema rather than ten bespoke tables:
--   * a derived P&L (all formulas, no input)          -> weekly_reports header
--   * label + numbers, repeated per line              -> weekly_report_lines
--   * per-person hours/rates/deliveries               -> weekly_report_labour_lines
--
-- WHY THESE TABLES ARE IN THE OPERATIONS PROJECT, NOT VM
-- The report needs employees, approved clock hours, manager accounts,
-- app_settings and audit_log — every one of them ops-side. Sales are two
-- scalars per store per week and are already fetched from VM at render time.
-- Putting the tables in VM instead would mean re-implementing the whole labour
-- prefill across an HTTP boundary.
--
-- It also avoids repeating the fault in migration 012. `weekly_summary_inputs`
-- was created as an ops migration but is read and written through
-- getVMSupabaseServer() — a client built against the VM project while carrying
-- the OPS session cookies. @supabase/ssr looks for `sb-<vm-ref>-auth-token`,
-- which never exists, so that client is anonymous and 012's
-- `auth.role() = 'authenticated'` policies deny it. Everything below is reached
-- through createServerSupabase() and gated by is_staff() / can_access_store(),
-- exactly like the rest of the operations schema.
--
-- THE LOCK, and why it matters
-- Same pattern as cash_payouts: a locked report is a FROZEN SNAPSHOT, not a
-- live view. Changing how a figure is computed must never restate a report that
-- has already been mailed to the superiors, so lock writes `snapshot` with the
-- sales and every derived P&L figure as they stood at that moment.
--
-- Idempotent. Run in the Supabase SQL editor (or via `supabase db push`).
-- =============================================================

-- =============================================================
-- The store identity bridge
--
-- VM keys on the store NAME ("Peckers Stevenage"); ops keys on stores.id.
-- A column rather than a hard-coded TypeScript map: it is data, and it puts the
-- mapping where a new store gets added.
-- =============================================================
alter table public.stores
  add column if not exists vm_store_name text;

comment on column public.stores.vm_store_name is
  'This store''s name in the VM Analytics project (e.g. "Peckers Stevenage"). Null = no sales data joins to this store. The ONLY mapping between the two Supabase projects — never hard-code it in TypeScript.';

update public.stores set vm_store_name = 'Peckers Stevenage'
  where code = 'stevenage' and vm_store_name is null;
update public.stores set vm_store_name = 'Peckers Hitchin'
  where code = 'hitchin' and vm_store_name is null;

-- =============================================================
-- TABLE: weekly_reports — one header per store per week
--
-- packaging_costs, marketing and cogs_hitchin stay HEADER SCALARS because the
-- workbook has them as single hand-typed numbers. cogs_hitchin in particular is
-- deliberate: the "Cogs transferred to hitchin" sheet sits right next to it in
-- the workbook and feeds nothing, and wiring the sheet total into this column
-- would silently change the P&L. See the note on the section list below.
-- =============================================================
create table if not exists public.weekly_reports (
  id                      uuid primary key default gen_random_uuid(),
  store_id                uuid not null references public.stores(id) on delete cascade,
  -- ISO Monday, the same week key the rota, payout and VM weeks all use.
  week_start              date not null,
  status                  text not null default 'draft'
                            check (status in ('draft','locked','sent')),

  packaging_costs         numeric(10,2),
  marketing               numeric(10,2),
  -- B11 on the summary. Hand-typed; NOT a roll-up of the cogs_hitchin section.
  cogs_hitchin            numeric(10,2),
  -- Stored as decimals (0.65 = 65%), matching weekly_summary_inputs.
  gross_margin_budget_pct numeric(5,4),
  labour_budget_pct       numeric(5,4),

  -- FROZEN at lock: gross/net sales plus every derived figure. Null while draft.
  snapshot                jsonb,
  locked_at               timestamptz,
  locked_by               uuid references auth.users(id) on delete set null,
  sent_at                 timestamptz,
  sent_by                 uuid references auth.users(id) on delete set null,
  sent_to                 text[],

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (store_id, week_start)
);

comment on table public.weekly_reports is
  'One weekly P&L per store. Replaces the manager''s Excel workbook. Locked reports are frozen snapshots, exactly like a confirmed cash_payouts row.';
comment on column public.weekly_reports.snapshot is
  'Written ONLY at lock. Holds the sales and every derived P&L figure as computed at that moment, so changing the calculation later cannot restate a report already sent.';
comment on column public.weekly_reports.cogs_hitchin is
  'Summary line B11, hand-typed. Deliberately NOT connected to the cogs_hitchin SECTION in weekly_report_lines — the transfer sheet is a record, not a P&L input.';

create index if not exists weekly_reports_store_week_idx
  on public.weekly_reports (store_id, week_start desc);

drop trigger if exists set_weekly_reports_updated_at on public.weekly_reports;
create trigger set_weekly_reports_updated_at
  before update on public.weekly_reports
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: weekly_report_lines — label + numbers, nine of the ten sheets
--
-- One row per line the manager types. `section` says which sheet it came from:
--
--   cogs_supplier  Cost Of Goods        label + amount, ONE ROW PER INVOICE
--                                       (the sheet had 3 fixed columns; a
--                                       supplier can now have 5)
--   cogs_walkern   COGS walkern         label + amount        RECORD ONLY
--   cogs_hitchin   Cogs to hitchin      label + amount        RECORD ONLY
--   occupancy      Occupancy costs      label + amount
--   rice_bowls     Samosas Fillings A:C label = day,  qty x unit_rate
--   fillings       Samosas Fillings E:F label = site, amount
--   samosas        Samosas Fillings H:J label = site, qty x unit_rate
--   spring_rolls   Samosas Fillings H7  label = day,  qty x unit_rate
--   aggregator     Agreggator summary   label = platform, amount = COMMISSION
--                                       (sales come from VM, income derives)
--   expense        Weekly Expense Sheet entry_date + label + note + amount
--                                                             RECORD ONLY
--
-- RECORD ONLY means exactly that: the lines are entered and totalled and change
-- no P&L formula. Their tabs say so, so the disconnect reads as a decision
-- rather than a bug.
--
-- WHY THE UNIT RATES LIVE ON THE ROW. 70p a samosa and £2.50 a rice bowl are
-- prices that will change. Stored per line and carried forward from last week, a
-- price rise is one field edit and every already-locked week keeps the rate it
-- was actually costed at. Hard-coding them in TypeScript would silently restate
-- history.
-- =============================================================
create table if not exists public.weekly_report_lines (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.weekly_reports(id) on delete cascade,
  section     text not null check (section in (
                'cogs_supplier','cogs_walkern','cogs_hitchin','occupancy',
                'rice_bowls','fillings','samosas','spring_rolls',
                'aggregator','expense')),
  label       text not null,
  sort_order  int not null default 0,
  entry_date  date,
  qty         numeric(12,3),
  unit_rate   numeric(10,4),
  -- Entered directly, or the stored result of qty x unit_rate. The application
  -- reads `amount` when set and falls back to the product, so a qty-and-rate
  -- section never needs a second source of truth.
  amount      numeric(12,2),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.weekly_report_lines is
  'One typed line on a weekly report sub-page. Nine of the workbook''s ten sheets share this shape; only Labour Cost needs its own table.';
comment on column public.weekly_report_lines.amount is
  'The line''s money. On qty x unit_rate sections this is the computed product, stored so a later rate change cannot restate a line already entered.';
comment on column public.weekly_report_lines.section is
  'cogs_walkern, cogs_hitchin and expense are RECORD ONLY — entered and totalled, but they feed no P&L formula.';

create index if not exists weekly_report_lines_report_section_idx
  on public.weekly_report_lines (report_id, section, sort_order);

drop trigger if exists set_weekly_report_lines_updated_at on public.weekly_report_lines;
create trigger set_weekly_report_lines_updated_at
  before update on public.weekly_report_lines
  for each row execute function public.set_updated_at();

-- =============================================================
-- TABLE: weekly_report_labour_lines — its own table, because the shape differs
--
-- The Labour sheet carries TWO hour/rate pairs plus deliveries per person.
-- Forcing that into the generic table above would mean four unlabelled numeric
-- columns, which is how a schema stops being readable.
--
-- Derived, never stored: ni_total = ni_hours x ni_rate, cash_total = cash_hours
-- x cash_rate, total_pay = ni_total + cash_total + delivery_pay + fixed_pay.
-- The week's labour total is stored only in the header snapshot, at lock.
--
-- THE P&L LABOUR FIGURE IS THE FULL COST, not the cash the Tuesday sheet pays.
-- The payout deliberately excludes NI/bank hours (they go through PAYE), so
-- grand_total_wages is the wrong number to copy — hence the NI columns here.
-- =============================================================
create table if not exists public.weekly_report_labour_lines (
  id              uuid primary key default gen_random_uuid(),
  report_id       uuid not null references public.weekly_reports(id) on delete cascade,
  person_name     text not null,
  source          text not null default 'adhoc'
                    check (source in ('employee','cover_driver','manager','adhoc')),
  -- Nullable and ON DELETE SET NULL throughout: deleting someone's profile must
  -- not erase a week that has already been costed and possibly sent.
  employee_id     uuid references public.employees(id) on delete set null,
  cover_driver_id uuid references public.cover_drivers(id) on delete set null,
  manager_id      uuid references public.allowed_users(id) on delete set null,
  hours           numeric(8,2),
  ni_hours        numeric(8,2),
  ni_rate         numeric(8,2),
  cash_hours      numeric(8,2),
  cash_rate       numeric(8,2),
  deliveries      int,
  delivery_pay    numeric(10,2),
  -- A manager is on a fixed daily wage, which no hour x rate pair can express.
  -- Their labour cost is days-clocked x fixed_daily_wage and lands here.
  fixed_pay       numeric(10,2),
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.weekly_report_labour_lines is
  'One person''s week on a weekly report. Prefilled from APPROVED hours (never the rota), then corrected by hand — a prefill writes rows, it is not a live join.';
comment on column public.weekly_report_labour_lines.source is
  'adhoc = someone who came for one week and is not on the rota: name + hours + rate typed by hand, no FK, nothing downstream.';
comment on column public.weekly_report_labour_lines.fixed_pay is
  'A manager''s fixed daily wage for the days they clocked. Zero for everyone else, whose pay is hours x rate.';

create index if not exists weekly_report_labour_lines_report_idx
  on public.weekly_report_labour_lines (report_id, sort_order);

drop trigger if exists set_weekly_report_labour_lines_updated_at on public.weekly_report_labour_lines;
create trigger set_weekly_report_labour_lines_updated_at
  before update on public.weekly_report_labour_lines
  for each row execute function public.set_updated_at();

-- =============================================================
-- RLS
--
-- SELECT is is_staff(): the combined (both-stores) roll-up is a real screen, and
-- an admin reading it needs both stores' reports. WRITES are can_access_store(),
-- so a manager can only ever edit their own store's week — the same split the
-- rest of the operations schema uses.
-- =============================================================
alter table public.weekly_reports              enable row level security;
alter table public.weekly_report_lines         enable row level security;
alter table public.weekly_report_labour_lines  enable row level security;

drop policy if exists "weekly_reports_select" on public.weekly_reports;
drop policy if exists "weekly_reports_modify" on public.weekly_reports;

create policy "weekly_reports_select" on public.weekly_reports
  for select to authenticated
  using (public.is_staff());

create policy "weekly_reports_modify" on public.weekly_reports
  for all to authenticated
  using (public.can_access_store(store_id))
  with check (public.can_access_store(store_id));

drop policy if exists "weekly_report_lines_select" on public.weekly_report_lines;
drop policy if exists "weekly_report_lines_modify" on public.weekly_report_lines;

create policy "weekly_report_lines_select" on public.weekly_report_lines
  for select to authenticated
  using (public.is_staff());

create policy "weekly_report_lines_modify" on public.weekly_report_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.weekly_reports r
      where r.id = report_id and public.can_access_store(r.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.weekly_reports r
      where r.id = report_id and public.can_access_store(r.store_id)
    )
  );

drop policy if exists "weekly_report_labour_lines_select" on public.weekly_report_labour_lines;
drop policy if exists "weekly_report_labour_lines_modify" on public.weekly_report_labour_lines;

create policy "weekly_report_labour_lines_select" on public.weekly_report_labour_lines
  for select to authenticated
  using (public.is_staff());

create policy "weekly_report_labour_lines_modify" on public.weekly_report_labour_lines
  for all to authenticated
  using (
    exists (
      select 1 from public.weekly_reports r
      where r.id = report_id and public.can_access_store(r.store_id)
    )
  )
  with check (
    exists (
      select 1 from public.weekly_reports r
      where r.id = report_id and public.can_access_store(r.store_id)
    )
  );
