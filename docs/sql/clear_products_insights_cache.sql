-- Clear cached Product Performance commentary so the corrected top-category %
-- (now "% of total net sales", Update 29) regenerates on the next page load.
--
-- Matches every products key variant:
--   products                          (legacy, unversioned, all stores)
--   products#v3                       (versioned, all stores)
--   products@Peckers Hitchin#v3       (versioned, per store)
--   products@Peckers Stevenage#v3
--
-- Run steps 1 → 2 → 3 in the Supabase SQL editor.

-- ── Step 1: preview what will be deleted ───────────────────────────────────
SELECT week_start_iso, dashboard, source, generated_at, summary
FROM vm_generated_insights
WHERE dashboard LIKE 'products%'
ORDER BY week_start_iso DESC, dashboard;

-- ── Step 2: delete the cached rows ─────────────────────────────────────────
DELETE FROM vm_generated_insights
WHERE dashboard LIKE 'products%';

-- ── Step 3: confirm the cache is empty ─────────────────────────────────────
SELECT count(*) AS remaining_products_rows
FROM vm_generated_insights
WHERE dashboard LIKE 'products%';


-- ───────────────────────────────────────────────────────────────────────────
-- Optional: clear one week only, instead of Step 2
-- ───────────────────────────────────────────────────────────────────────────
-- DELETE FROM vm_generated_insights
-- WHERE dashboard LIKE 'products%'
--   AND week_start_iso = '2026-07-20';   -- set to the week you are viewing

-- ───────────────────────────────────────────────────────────────────────────
-- Optional: clear one store only, instead of Step 2
-- ───────────────────────────────────────────────────────────────────────────
-- DELETE FROM vm_generated_insights
-- WHERE dashboard LIKE 'products@Peckers Stevenage%';

-- ───────────────────────────────────────────────────────────────────────────
-- Optional: nuclear — clear every dashboard's commentary cache
-- ───────────────────────────────────────────────────────────────────────────
-- DELETE FROM vm_generated_insights;
