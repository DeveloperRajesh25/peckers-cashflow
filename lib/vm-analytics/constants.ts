// Canonical store names exactly as stored in Supabase (meta `store` column).
export const STORES = ["Peckers Hitchin", "Peckers Stevenage"] as const;
export type StoreName = (typeof STORES)[number];

// Short labels for table headers / chart legends.
export const STORE_LABEL: Record<string, string> = {
  "Peckers Hitchin": "Hitchin",
  "Peckers Stevenage": "Stevenage",
};

export function shortStore(store: string): string {
  return STORE_LABEL[store] ?? store.replace(/^Peckers\s+/i, "");
}

// Resolve a ?store= query value ("hitchin" | "stevenage") to a canonical store
// name. Anything else (incl. undefined / "all") means "both stores combined".
export function resolveStore(param?: string): StoreName | null {
  if (!param) return null;
  const p = param.toLowerCase();
  return STORES.find((s) => shortStore(s).toLowerCase() === p) ?? null;
}

// Channel buckets for the Executive dashboard. "Delivery" = own delivery + the
// third-party platforms; everything else is treated as in-store (collection,
// kiosk, till). Order & Pay at Table is listed for completeness — it may not be
// present in every week's data.
export const DELIVERY_CHANNELS = [
  "Own Delivery",
  "Deliveroo",
  "Uber Eats",
  "Just Eat",
] as const;

export const IN_STORE_CHANNELS = [
  "Click & Collect",
  "Order & Pay at Table",
  "Kiosk",
  "Till (takeaway)",
  "Till (eat-in)",
] as const;

export function isDeliveryChannel(channel: string): boolean {
  return (DELIVERY_CHANNELS as readonly string[]).includes(channel);
}

// Canonical store key for joining data ACROSS sources whose naming differs:
//   VM views      -> "Peckers Hitchin"
//   Cashflow/rota -> "Hitchin Peckers"
// Both must collapse to the same key ("Hitchin") so labour cost can be matched
// to net sales. Matches on the distinctive town word, ignoring "Peckers".
export function canonicalStore(store: string): string {
  const s = (store ?? "").toLowerCase();
  if (s.includes("hitchin")) return "Hitchin";
  if (s.includes("stevenage")) return "Stevenage";
  return store;
}

export const normalizeItem = (s: string) =>
  s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

// Drinks and side add-ons excluded from menu-performance views: they attach to
// orders regardless of menu choice and would skew rankings / exception rules.
export const EXCLUDED_PRODUCTS = new Set(
  [
    "Pepsi Max",
    "Pepsi",
    "Fries",
    "Tango Orange",
    "Still Water",
    "Diet Pepsi",
    "7 Up Lemon and Lime",
    "Budweiser Bottle",
  ].map(normalizeItem),
);

// Also excludes any fries variant (Cheesy Fries, Loaded Fries, …): the exact
// set only matched plain "Fries", but no non-fries menu item contains "fries".
export const isExcludedProduct = (itemName: string) => {
  const norm = normalizeItem(itemName);
  return EXCLUDED_PRODUCTS.has(norm) || norm.includes("fries");
};

// Products hidden from the Product Performance dashboard everywhere (rankings AND
// category totals/drill-down) without touching the source data. Delete a line to
// bring one back. Kept separate from EXCLUDED_PRODUCTS, which only drops drinks/
// sides from rankings but keeps them in category totals.
export const HIDDEN_PRODUCTS = new Set(["The OG Burger & Chips"].map(normalizeItem));

// Loyalty stamp-card redemptions (see the physical card: 3 stamps = GAMMA free
// side, 6 = BETA free main, 10 = ALPHA free meal) ring through the till as
// dedicated "Alpha ..."-prefixed items — "Alpha OG burger meal", "Alpha 3
// Tender Meal", "Alpha 4 Wings Meal", "Alpha OG Peri Peri Burger Meal" — priced
// near zero, confirmed by SQL audit against vm_net_sales_per_product (2026-08-19,
// see docs/updates.md Update 119): every one nets £0-£11 against a real meal's
// £10-27, some literally £0. Matched by PREFIX rather than the exact-name list
// above so a new Alpha meal variant is excluded on day one, not after it's
// already shown up as a "least selling item". Beta/Gamma redemptions currently
// ring up as the ordinary menu item with a till discount (no dedicated SKU), so
// they can't be caught this way — see docs/updates.md Update 119 for the gap.
const REWARD_TIER_PREFIXES = ["alpha", "beta", "gamma"];

export const isHiddenProduct = (itemName: string) => {
  const norm = normalizeItem(itemName);
  return HIDDEN_PRODUCTS.has(norm) || REWARD_TIER_PREFIXES.some((prefix) => norm.startsWith(prefix));
};

// Thresholds for the Weekly Exception Report (rule-based exceptions).
export const EXCEPTION_THRESHOLDS = {
  labourTargetPct: 30, // labour % of NET sales above this = risk
  salesDeclinePct: -5, // net sales WoW below this = risk
  platformDependencePct: 40, // THIRD-PARTY platform share above this = risk
  attachDropPp: 3, // attachment drop (percentage points) below this = risk
  attachMinOrdersPct: 15, // only flag attachment for items in >= this % of orders
  productDeclinePct: -25, // revenue WoW below this (with volume) = underperformer
  productMinUnits: 20, // ignore tiny-volume items for underperformer risk
} as const;

// Third-party delivery platforms — these charge commission, so reliance on them
// is the real "platform dependence". Own Delivery is the store's own drivers and
// is deliberately NOT counted here. Matched case-insensitively against the
// platform label from vm_v_delivery_mix.
export const THIRD_PARTY_PLATFORMS = ["just eat", "uber", "deliveroo"] as const;

export function isThirdPartyPlatform(platform: string): boolean {
  const p = (platform ?? "").toLowerCase();
  return THIRD_PARTY_PLATFORMS.some((t) => p.includes(t));
}

// The dashboards exposed under the "VM Analytics" module dropdown.
export type DashboardKey =
  | "weekly-exception"
  | "executive"
  | "products"
  | "daypart"
  | "delivery"
  | "store-comparison"
  | "weekly-summary"
  | "labor-cost";

export interface DashboardDef {
  key: DashboardKey;
  href: string;
  title: string;
  blurb: string;
}

export const DASHBOARDS: DashboardDef[] = [
  {
    key: "weekly-exception",
    href: "/vm-analytics/weekly-exception",
    title: "Weekly Exception Report",
    blurb: "Opportunities & risks summary across all reports",
  },
  {
    key: "executive",
    href: "/vm-analytics/executive",
    title: "Executive Dashboard",
    blurb: "High-level overview of both stores",
  },
  {
    key: "products",
    href: "/vm-analytics/products",
    title: "Product Performance",
    blurb: "Best & worst performing menu items",
  },
  {
    key: "daypart",
    href: "/vm-analytics/daypart",
    title: "Daypart Analysis",
    blurb: "Trading patterns across the day",
  },
  {
    key: "delivery",
    href: "/vm-analytics/delivery",
    title: "Delivery Platform Performance",
    blurb: "Performance by ordering channel",
  },
  {
    key: "store-comparison",
    href: "/vm-analytics/store-comparison",
    title: "Store Comparison",
    blurb: "Hitchin vs Stevenage head-to-head",
  },
  {
    key: "weekly-summary",
    href: "/vm-analytics/weekly-summary",
    title: "Weekly Summary",
    blurb: "Manager P&L: costs, margins & net margin by store",
  },
  {
    key: "labor-cost",
    href: "/vm-analytics/labor-cost",
    title: "Labor Cost Performance",
    blurb: "Labor spend & efficiency metrics by store",
  },
];
