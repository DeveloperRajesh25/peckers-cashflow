-- ============================================================================
-- Category Performance — VM analytics (run in the VM Supabase project)
-- 1) item -> category mapping table (seeded)  2) aggregate view w/ WoW  3) drill-down view
-- Re-runnable: table upserts, views are CREATE OR REPLACE.
-- ============================================================================

create table if not exists vm_menu_item_category (
  item_name text primary key,
  category  text not null,
  updated_at timestamptz not null default now()
);

insert into vm_menu_item_category (item_name, category) values
  ('Buffalo Soldier Burger', 'Burgers'),
  ('Butter Me Up Burger 🇮🇳', 'Burgers'),
  ('Hert and Seoul Burger', 'Burgers'),
  ('Katsu Curry Burger', 'Burgers'),
  ('Mega Pecker Burger', 'Burgers'),
  ('Murgar on the Dance Floor Burger', 'Burgers'),
  ('Supercharged OG Burger', 'Burgers'),
  ('The OG Burger', 'Burgers'),
  ('1 piece Southern Fried Chicken', 'Chicken on the bone'),
  ('1 piece Southern Fried Chicken & Chips', 'Chicken on the bone'),
  ('2 pieces Southern Fried Chicken & Chips', 'Chicken on the bone'),
  ('2 Pieces Southern Fried Chicken & Chips', 'Chicken on the bone'),
  ('3 pieces Southern Fried Chicken & Chips', 'Chicken on the bone'),
  ('Cinnamon Sugar Coated Churros', 'Churros'),
  ('Nutella Churros', 'Churros'),
  ('Salted Caramel Churros', 'Churros'),
  ('Ben & Jerry''s Chocolate Fudge Brownie 465ml', 'Desserts'),
  ('Ben & Jerry''s Cookie Dough 465ml', 'Desserts'),
  ('Ben & Jerry''s Phish Food 465ml', 'Desserts'),
  ('7 up lemon & lime', 'Drinks'),
  ('Birra Moretti', 'Drinks'),
  ('Budweiser Bottle', 'Drinks'),
  ('Cruzcampo', 'Drinks'),
  ('Diet Pepsi', 'Drinks'),
  ('Dr Pepper Cream Soda', 'Drinks'),
  ('Fanta Berry', 'Drinks'),
  ('Fanta Grape', 'Drinks'),
  ('Fanta Pineapple', 'Drinks'),
  ('Fanta Strawberry', 'Drinks'),
  ('Guinness Draught', 'Drinks'),
  ('I heart Pinot Grigio', 'Drinks'),
  ('Pepsi', 'Drinks'),
  ('Pepsi Max', 'Drinks'),
  ('Still Water', 'Drinks'),
  ('Tango Orange', 'Drinks'),
  ('Cheesy Fries', 'Fries'),
  ('Fries', 'Fries'),
  ('Halloumi Fries with Chilli Jam', 'Fries'),
  ('Peckers Loaded Fries', 'Fries'),
  ('Mini Drumstick meal', 'Kids'),
  ('Mini OG meal', 'Kids'),
  ('Mini Tenders Meal', 'Kids'),
  ('Burger and Tenders Meal Box', 'Meal boxes'),
  ('Burger and Wings Meal Box', 'Meal boxes'),
  ('Wrap and Tender Meal Box', 'Meal boxes'),
  ('Wrap and Wing Meal Box', 'Meal boxes'),
  ('Baileys Milkshake', 'Milkshakes'),
  ('Cadbury Creme Egg Original Milkshake', 'Milkshakes'),
  ('Cadbury Creme Egg White Milkshake', 'Milkshakes'),
  ('Cadbury Mini Egg Milkshake', 'Milkshakes'),
  ('chocolate milkshake', 'Milkshakes'),
  ('Chocolate Milkshake', 'Milkshakes'),
  ('Ferrero Roche Milkshake', 'Milkshakes'),
  ('Galaxy Caramel Milkshake', 'Milkshakes'),
  ('Galaxy Original Milkshake', 'Milkshakes'),
  ('Kinder Bueno Milkshake', 'Milkshakes'),
  ('Kinder Bueno White', 'Milkshakes'),
  ('Kinder Bueno White Milkshake', 'Milkshakes'),
  ('Lotus Biscoff Milkshake', 'Milkshakes'),
  ('Mango Pineapple Milkshake', 'Milkshakes'),
  ('nutella milkshake', 'Milkshakes'),
  ('Nutella Milkshake', 'Milkshakes'),
  ('Og Matcha', 'Milkshakes'),
  ('oreo cookie pieces milkshake', 'Milkshakes'),
  ('Oreo Cookie Pieces Milkshake', 'Milkshakes'),
  ('Oreo Crumble Matcha', 'Milkshakes'),
  ('REESE''S Peanut Butter Cups Milkshake', 'Milkshakes'),
  ('Strawberry Matcha', 'Milkshakes'),
  ('Terry''s Orange Milkshake', 'Milkshakes'),
  ('Vanilla milkshake', 'Milkshakes'),
  ('Vanilla Milkshake', 'Milkshakes'),
  ('3 Peri Peri Flame Grilled Wings', 'Peri peri grilled'),
  ('Jerk Wings 🇯🇲', 'Peri peri grilled'),
  ('OG PERi PERi Burger & Chips', 'Peri peri grilled'),
  ('OG PERi PERi Grilled Wrap & Chips', 'Peri peri grilled'),
  ('OG PERI-PERI  Grilled Rice Bowl', 'Peri peri grilled'),
  ('OG PERI-PERI Grilled Burger', 'Peri peri grilled'),
  ('OG PERI-PERI Grilled Salad Bowl', 'Peri peri grilled'),
  ('OG PERI-PERI Grilled Wrap', 'Peri peri grilled'),
  ('Peckers Grilled Snack-wrap', 'Peri peri grilled'),
  ('PERI PERI Butterfly Chicken', 'Peri peri grilled'),
  ('Peckers Health Box', 'Peri peri grilled'),
  ('PERI PERI Grilled Wings', 'Peri peri grilled'),
  ('PERI PERI Half Grilled Chicken', 'Peri peri grilled'),
  ('PERI PERI Quarter Grilled Chicken', 'Peri peri grilled'),
  ('Quarter Grilled Chicken & Chips', 'Peri peri grilled'),
  ('Mini Platter for 1', 'Platters'),
  ('Peckers Fried Platter for 4', 'Platters'),
  ('Peckers Platter for 4', 'Platters'),
  ('Buffalo Soldier Rice Bowl', 'Rice bowl'),
  ('Hert and Seoul Rice Bowl', 'Rice bowl'),
  ('Katsu Curry Rice bowl', 'Rice bowl'),
  ('Mega Pecker Rice Bowl', 'Rice bowl'),
  ('Murgar on the Dance Floor Rice Bowl', 'Rice bowl'),
  ('Supercharged Rice Bowl', 'Rice bowl'),
  ('The OG Rice Bowl', 'Rice bowl'),
  ('Buffalo Soldier Salad Bowl', 'Salad bowl'),
  ('Hert and Seoul Salad Bowl', 'Salad bowl'),
  ('Katsu Curry Salad Bowl', 'Salad bowl'),
  ('Mega Pecker Salad Bowl', 'Salad bowl'),
  ('Murgar on the Dance Floor Salad Bowl', 'Salad bowl'),
  ('The OG Salad Bowl', 'Salad bowl'),
  ('Garlic Mayo', 'Sauces'),
  ('House Ranch', 'Sauces'),
  ('Korean Glaze', 'Sauces'),
  ('OG Chilli Sauce', 'Sauces'),
  ('Peckers House Mayo', 'Sauces'),
  ('Corn on the Cob', 'Sides'),
  ('Grilled Halloumi', 'Sides'),
  ('House OG Slaw', 'Sides'),
  ('Mac & Cheese', 'Sides'),
  ('Mac & Cheese Sticks', 'Sides'),
  ('Peckers Gravy (v)(gf)', 'Sides'),
  ('Rice Bowl', 'Sides'),
  ('Salad', 'Sides'),
  ('2 Buffalo Tenders', 'Tenders'),
  ('2 Butter Me Up Tenders', 'Tenders'),
  ('2 Garlic Aioli Tenders', 'Tenders'),
  ('2 Honey Glazed BBQ Tenders', 'Tenders'),
  ('2 Hot Honey Tenders', 'Tenders'),
  ('2 Katsu Curry Tenders', 'Tenders'),
  ('2 Korean Gochujang Tenders', 'Tenders'),
  ('2 Peanut Sweet Chilli Coriander Tenders', 'Tenders'),
  ('2 Southern Fried Buttermilk Tenders', 'Tenders'),
  ('2 Supercharged Tenders', 'Tenders'),
  ('Buffalo Tenders', 'Tenders'),
  ('Butter Me Up Tenders 🇮🇳', 'Tenders'),
  ('Garlic Aioli Tenders', 'Tenders'),
  ('Honey Glazed BBQ Tenders', 'Tenders'),
  ('Hot Honey Tenders', 'Tenders'),
  ('Katsu Curry Tenders', 'Tenders'),
  ('Korean Gochujang Tenders', 'Tenders'),
  ('Southern fried Mango Pineappled Glazed Tenders','Tenders'),
  ('Mango Pineapple Glazed Southern Fried Buttermilk Tenders', 'Tenders'),
  ('Mango Pineapple Glazed Tenders','Tenders'),
  ('Peanut Sweet Chilli Coriander Tenders', 'Tenders'),
  ('Southern Fried  Buttermilk Tenders', 'Tenders'),
  ('Southern Fried Buttermilk Tenders', 'Tenders'),
  ('Supercharged Tenders', 'Tenders'),
  ('Peckersless Hert and Seoul Burger', 'Veggie'),
  ('Peckersless Hert and Seoul Wrap', 'Veggie'),
  ('Peckersless Mega Pecker Burger', 'Veggie'),
  ('Peckersless Mega Pecker Wrap', 'Veggie'),
  ('Peckersless Murgar on the Dance Floor Burger', 'Veggie'),
  ('Peckersless Murgar on the Dance Floor Wrap', 'Veggie'),
  ('Peckersless OG Burger', 'Veggie'),
  ('Peckersless OG Wrap', 'Veggie'),
  ('Peckersless Rice Bowl', 'Veggie'),
  ('Peckersless Salad Bowl', 'Veggie'),
  ('3 Buffalo wings', 'Wings'),
  ('3 Butter Me Up Wings', 'Wings'),
  ('3 Garlic Aioli Wings', 'Wings'),
  ('3 Honey Glazed BBQ wings', 'Wings'),
  ('3 Hot Honey Wings', 'Wings'),
  ('3 Katsu Curry Wings', 'Wings'),
  ('3 Korean Gouchjang wings', 'Wings'),
  ('3 Peanut sweet chilli wings', 'Wings'),
  ('3 Southern Fried Wings', 'Wings'),
  ('4 Butter Me Up Wings', 'Wings'),
  ('4 Sfc Wings', 'Wings'),
  ('4 Hot Honey Wings','Wings'),
  ('Buffalo wings', 'Wings'),
  ('Butter Me Up Wings 🇮🇳', 'Wings'),
  ('Garlic Aioli Wings', 'Wings'),
  ('Honey Glazed BBQ Wings', 'Wings'),
  ('Hot Honey Wings', 'Wings'),
  ('Katsu Curry Wings', 'Wings'),
  ('Korean Gochujang Wings', 'Wings'),
  ('Mango Pineapple Glazed Wings','Wings'),
  ('Mango Pineapple Glazed Southern Fried Wings','Wings'),
  ('Peanut Sweet Chilli Wings', 'Wings'),
  ('Southern Fried Wings', 'Wings'),
  ('Supercharged wings', 'Wings'),
  ('Buffalo Soldier Wrap', 'Wraps'),
  ('Butter Me Up Wrap 🇮🇳', 'Wraps'),
  ('Hert and Seoul Wrap', 'Wraps'),
  ('Katsu Curry Wrap', 'Wraps'),
  ('Mega Pecker Wrap', 'Wraps'),
  ('Murgar on the Dance Floor Wrap', 'Wraps'),
  ('OG Wrap & chips', 'Wraps'),
  ('Supercharged OG Wrap', 'Wraps'),
  ('The OG Wrap', 'Wraps')
on conflict (item_name) do update set category = excluded.category, updated_at = now();

-- Single source of truth for item -> category, used by both views below.
-- 1) exact match against the curated table (authoritative; wins first)
-- 2) fallback for self-describing names: anything ending in wing(s)/tender(s).
--    This auto-classifies new flavours and quantity-prefixed names
--    ("2 Mango Pineapple Glazed Tenders") without a table edit.
-- 3) otherwise Uncategorised.
--
-- search_path is pinned so the unqualified `vm_menu_item_category` reference
-- below can never fail to resolve based on the calling session's search_path.
-- A plain `create or replace view` never surfaced this because a view doesn't
-- execute its query at creation time — but `create materialized view` does,
-- immediately, in whatever search_path the SQL editor session happens to have.
create or replace function vm_category_for(p_item_name text)
returns text
language sql
stable
set search_path = public
as $$
  with n as (
    select regexp_replace(lower(btrim(p_item_name)), '\s+', ' ', 'g') as name
  )
  select coalesce(
    (select m.category
       from vm_menu_item_category m
      where regexp_replace(lower(btrim(m.item_name)), '\s+', ' ', 'g') = (select name from n)
      limit 1),
    (select case
       when name like '%wing' or name like '%wings' then 'Wings'
       when name like '%tender' or name like '%tenders' then 'Tenders'
     end from n),
    'Uncategorised'
  );
$$;

-- These view names may already exist with a different (older) column set.
-- CREATE OR REPLACE VIEW can only append columns, never change existing ones, so
-- drop first. No CASCADE: if anything else depends on them the drop will fail and
-- name the dependent rather than silently removing it.
drop view if exists vm_v_product_category;
drop view if exists vm_v_category_performance;

-- Aggregate: one row per store x week x category, with SQL-computed WoW vs the
-- same category the previous week (exact 7-day match, so gaps don't misalign).
create or replace view vm_v_category_performance as
with base as (
  select p.store,
         p.week_start,
         vm_category_for(p.item_name) as category,
         sum(p.units_sold)  as units_sold,
         sum(p.gross_sales) as gross_sales
  from vm_v_product_performance p
  group by p.store, p.week_start, vm_category_for(p.item_name)
)
select b.store,
       b.week_start,
       b.category,
       b.units_sold,
       b.gross_sales,
       case when pw.gross_sales > 0
            then (b.gross_sales - pw.gross_sales) / pw.gross_sales * 100 end as revenue_wow_pct,
       case when pw.units_sold > 0
            then (b.units_sold - pw.units_sold) / pw.units_sold * 100 end as units_wow_pct
from base b
left join base pw
  on pw.store = b.store
 and pw.category = b.category
 and pw.week_start::date = b.week_start::date - 7;

-- Drill-down: every item row tagged with its category (for expanding a category).
create or replace view vm_v_product_category as
select p.*,
       vm_category_for(p.item_name) as category
from vm_v_product_performance p;
