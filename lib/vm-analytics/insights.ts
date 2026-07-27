// Deterministic, zero-dependency commentary generator. Produces management-
// style summaries from the KPI facts each dashboard extracts. This is the
// default ("Auto") commentary AND the structured guide handed to Claude when an
// ANTHROPIC_API_KEY is present (see app/api/vm-analytics/insights/route.ts).
//
// Principles (these drive business decisions, so accuracy first):
//  • Never round money — figures are shown to the penny (£14,645.00, not £14,645
//    or "£15k"). Units/orders are shown exactly as recorded.
//  • Write in plain, story-telling English a non-technical owner can act on.
//  • Whenever AOV is mentioned it is split into Delivery AOV and In-store AOV.
//  • Commentary is scoped to the selected store when one is chosen.

import type { Insight } from "@/lib/vm-analytics/types";
import { shortStore } from "@/lib/vm-analytics/constants";
import { truncTo } from "@/lib/vm-analytics/format";

// Money to the penny — no rounding.
const gbp = (v: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v || 0);

// Plain counts (units / orders / customers) — exact, never rounded up or down.
const num = (v: number) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(v || 0);

// Signed week-on-week %, e.g. "+8.21%" / "-15.84%". Truncated (never rounded up).
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${truncTo(v, 2).toFixed(2)}%`;

// Unsigned share %, e.g. "47.31%". Truncated to 2dp so it never rounds up.
const share = (v: number | null | undefined) => `${truncTo(v ?? 0, 2).toFixed(2)}%`;

// Capitalise the first letter of a sentence fragment.
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// "across both stores" / "at Hitchin" depending on scope.
const scopePhrase = (store?: string | null) =>
  store ? `at ${shortStore(store)}` : "across both stores";

// ---------------------------------------------------------------------------

export interface ExecStoreFacts {
  store: string;
  netSales: number;
  deliveryNetSales: number;
  inStoreNetSales: number;
  orders: number;
  aov: number; // blended
  deliveryAov: number;
  inStoreAov: number;
  customers: number;
  deliveryPct: number; // delivery net sales as % of net sales
  inStorePct: number;
  collectionPct: number;
  eatInPct: number;
  netSalesWow: number | null;
}

export interface ExecInput {
  dashboard: "executive";
  week: string;
  // Selected store ("Peckers Hitchin" | "Peckers Stevenage"), or null/undefined
  // for the combined All-Stores view. Scopes both the commentary and its cache.
  store?: string | null;
  stores: ExecStoreFacts[];
  combined: {
    netSales: number;
    deliveryNetSales: number;
    inStoreNetSales: number;
    orders: number;
    aov: number;
    deliveryAov: number;
    inStoreAov: number;
    deliveryPct: number;
    inStorePct: number;
    customers: number;
  };
  totalWow: number | null;
}

export interface ProductInput {
  dashboard: "products";
  week: string;
  store?: string | null;
  // Single best-selling item by UNITS (volume) — named in the summary as a nod
  // to the Volume Leaders chart, which shows items rather than categories.
  top: { item: string; units: number; revenue: number; revWow: number | null; prevRevenue?: number; prevUnits?: number }[];
  // Category-level data now drives the commentary. Revenue desc, "Uncategorised"
  // excluded (add-on categories like Fries/Drinks are kept — they are real volume).
  categories: { category: string; units: number; revenue: number; revWow: number | null }[];
  risingCats: { category: string; revenue: number; prevRevenue?: number; revWow: number }[];
  fallingCats: { category: string; revenue: number; prevRevenue?: number; revWow: number }[];
  // Total net sales for the scoped store(s) — used to calculate category % of total sales
  totalNetSales: number;
}

export interface DaypartInput {
  dashboard: "daypart";
  week: string;
  store?: string | null;
  hours: { label: string; orders: number; revenue: number; aov: number }[];
  heatmap: {
    busiestDay: { day: string; orders: number } | null;
    quietestDay: { day: string; orders: number } | null;
    peakCell: { day: string; hourLabel: string; orders: number } | null;
    totalOrders: number;
  };
}

export interface DeliveryInput {
  dashboard: "delivery";
  week: string;
  store?: string | null;
  channels: {
    platform: string;
    revenue: number;
    orders: number;
    aov: number;
    sharePct: number;
    wow: number | null;
  }[];
}

export interface ComparisonInput {
  dashboard: "store-comparison";
  week: string;
  store?: string | null;
  stores: {
    store: string;
    revenue: number;
    orders: number;
    aov: number; // blended
    deliveryAov: number;
    inStoreAov: number;
    customers: number;
  }[];
}

export type InsightInput =
  | ExecInput
  | ProductInput
  | DaypartInput
  | DeliveryInput
  | ComparisonInput;

// ---------------------------------------------------------------------------

function execInsight(i: ExecInput): { summary: string; bullets: string[] } {
  const bullets: string[] = [];

  const c = i.combined;
  const scope = scopePhrase(i.store);

  // Per the owner's request the narrative summary paragraph is intentionally
  // omitted on the Executive dashboard (the headline KPI cards already carry the
  // net-sales / delivery-split / AOV story). Only the per-store bullets remain.
  const summary = "";

  for (const s of i.stores) {
    bullets.push(
      `${shortStore(s.store)}: ${gbp(s.netSales)} net sales from ${num(
        s.orders
      )} orders${
        s.netSalesWow !== null
          ? `, ${s.netSalesWow >= 0 ? "up" : "down"} ${pct(s.netSalesWow)} on last week`
          : ""
      }. Delivery AOV ${gbp(s.deliveryAov)}, in-store AOV ${gbp(s.inStoreAov)}.`
    );
  }

  bullets.push(
    `Channel split ${scope}: delivery ${share(c.deliveryPct)} of sales, in-store ${share(
      c.inStorePct
    )} — Delivery AOV ${gbp(c.deliveryAov)} vs In-store AOV ${gbp(c.inStoreAov)}.`
  );

  return { summary, bullets };
}

function productInsight(i: ProductInput): { summary: string; bullets: string[] } {
  const bullets: string[] = [];
  const scope = scopePhrase(i.store);
  const cats = i.categories;
  const topCat = cats[0];

  if (!topCat) {
    return {
      summary: `No category sales were recorded ${scope} this week.`,
      bullets: [],
    };
  }

  const topShare = i.totalNetSales > 0 ? (topCat.revenue / i.totalNetSales) * 100 : 0;

  let summary = `The top category ${scope} this week was ${topCat.category}, bringing in ${gbp(
    topCat.revenue
  )} — ${share(topShare)} of total net sales.`;
  const best = i.top[0];
  if (best) {
    summary += ` The single best-selling item was the ${best.item}, at ${num(
      best.units
    )} units.`;
  }

  if (i.risingCats.length) {
    bullets.push(
      `Growing categories: ${i.risingCats
        .slice(0, 3)
        .map((c) => {
          const prev = c.prevRevenue ? gbp(c.prevRevenue) : "—";
          return `${c.category} (${prev} → ${gbp(c.revenue)}, ${pct(c.revWow)})`;
        })
        .join("; ")}.`
    );
  }
  if (i.fallingCats.length) {
    bullets.push(
      `Shrinking categories: ${i.fallingCats
        .slice(0, 3)
        .map((c) => {
          const prev = c.prevRevenue ? gbp(c.prevRevenue) : "—";
          return `${c.category} (${prev} → ${gbp(c.revenue)}, ${pct(c.revWow)})`;
        })
        .join("; ")} — worth reviewing.`
    );
  }
  if (!i.risingCats.length && !i.fallingCats.length) {
    bullets.push("Week-on-week category trends will appear once a second week of data is synced.");
  }

  for (const c of cats.slice(0, 5)) {
    bullets.push(
      `${c.category}: ${num(c.units)} units · ${gbp(c.revenue)}${
        c.revWow !== null ? ` (${pct(c.revWow)} WoW)` : ""
      }.`
    );
  }
  return { summary, bullets };
}

function daypartInsight(i: DaypartInput): { summary: string; bullets: string[] } {
  const bullets: string[] = [];
  const scope = scopePhrase(i.store);
  const ranked = [...i.hours].sort((a, b) => b.orders - a.orders);
  const peakHour = ranked[0];

  if (!peakHour) {
    return {
      summary: `No trading activity was recorded ${scope} this week.`,
      bullets: [],
    };
  }

  const hm = i.heatmap;
  let summary = `${cap(scope)}, the busiest trading hour this week was ${peakHour.label} (${num(
    peakHour.orders
  )} orders, ${gbp(peakHour.revenue)})`;
  if (hm.busiestDay) {
    summary += `, and ${hm.busiestDay.day} was the busiest day of the week at ${num(
      hm.busiestDay.orders
    )} orders`;
  }
  summary += ".";
  if (hm.peakCell) {
    summary += ` The single peak window was ${hm.peakCell.day} ${hm.peakCell.hourLabel}, with ${num(
      hm.peakCell.orders
    )} orders.`;
  }
  if (hm.quietestDay) {
    summary += ` ${hm.quietestDay.day} was the quietest day, making it the natural target for a promotion.`;
  }

  for (const h of ranked.slice(0, 5)) {
    bullets.push(
      `${h.label}: ${num(h.orders)} orders · ${gbp(h.revenue)} · ${gbp(
        h.aov
      )} average order value.`
    );
  }
  return { summary, bullets };
}

function deliveryInsight(i: DeliveryInput): { summary: string; bullets: string[] } {
  const bullets: string[] = [];
  const scope = scopePhrase(i.store);
  const ranked = [...i.channels].sort((a, b) => b.revenue - a.revenue);
  const top = ranked[0];

  let summary = top
    ? `${cap(scope)}, ${top.platform} was the biggest ordering channel this week with ${gbp(
        top.revenue
      )} (${share(top.sharePct)} of revenue).`
    : `No channel activity was recorded ${scope} this week.`;

  const bestAov = [...i.channels].sort((a, b) => b.aov - a.aov)[0];
  if (bestAov) {
    summary += ` ${bestAov.platform} had the highest average order value at ${gbp(
      bestAov.aov
    )} per order.`;
  }

  for (const c of ranked.slice(0, 6)) {
    bullets.push(
      `${c.platform}: ${gbp(c.revenue)} (${share(c.sharePct)}) · ${num(
        c.orders
      )} orders · ${gbp(c.aov)} AOV${c.wow !== null ? ` (${pct(c.wow)} WoW)` : ""}.`
    );
  }

  const direct = i.channels.find((c) =>
    /own|direct|in-store|collect/i.test(c.platform)
  );
  if (direct) {
    bullets.push(
      `Your own / first-party channels are ${share(
        direct.sharePct
      )} of revenue — growing these keeps more margin out of aggregator commission.`
    );
  }
  return { summary, bullets };
}

function comparisonInsight(i: ComparisonInput): {
  summary: string;
  bullets: string[];
} {
  const bullets: string[] = [];
  if (i.stores.length < 2) {
    return {
      summary: "Two stores are required for a comparison.",
      bullets: i.stores.map(
        (s) =>
          `${shortStore(s.store)}: ${gbp(s.revenue)} revenue from ${num(
            s.orders
          )} orders.`
      ),
    };
  }
  const [a, b] = i.stores;
  const revLead = a.revenue >= b.revenue ? a : b;
  const revLag = revLead === a ? b : a;
  const revGap =
    revLag.revenue > 0
      ? ((revLead.revenue - revLag.revenue) / revLag.revenue) * 100
      : 0;

  const summary = `${shortStore(revLead.store)} out-sold ${shortStore(
    revLag.store
  )} this week, taking ${gbp(revLead.revenue)} against ${gbp(
    revLag.revenue
  )} — ${share(revGap)} more revenue.`;

  for (const s of i.stores) {
    bullets.push(
      `${shortStore(s.store)}: ${gbp(s.revenue)} from ${num(
        s.orders
      )} orders. Delivery AOV ${gbp(s.deliveryAov)}, in-store AOV ${gbp(
        s.inStoreAov
      )}, blended ${gbp(s.aov)}.`
    );
  }

  const ordLead = a.orders >= b.orders ? a : b;
  const ordLag = ordLead === a ? b : a;
  const ordGap =
    ordLag.orders > 0
      ? ((ordLead.orders - ordLag.orders) / ordLag.orders) * 100
      : 0;
  bullets.push(
    `${shortStore(ordLead.store)} served ${share(ordGap)} more orders than ${shortStore(
      ordLag.store
    )} (${num(ordLead.orders)} vs ${num(ordLag.orders)}).`
  );
  return { summary, bullets };
}

export function buildInsights(input: InsightInput): Insight {
  let res: { summary: string; bullets: string[] };
  switch (input.dashboard) {
    case "executive":
      res = execInsight(input);
      break;
    case "products":
      res = productInsight(input);
      break;
    case "daypart":
      res = daypartInsight(input);
      break;
    case "delivery":
      res = deliveryInsight(input);
      break;
    case "store-comparison":
      res = comparisonInsight(input);
      break;
  }
  return { source: "rules", ...res };
}

// Prompt fed to Claude: the raw facts + the rule-based draft as a style guide.
export function buildClaudePrompt(input: InsightInput): string {
  const draft = buildInsights(input);
  const scope =
    "store" in input && input.store
      ? `Only ${shortStore(input.store)} is in scope — write about that store only.`
      : "Both stores (Hitchin and Stevenage) are in scope.";
  return [
    "You are a hospitality operations analyst writing a concise weekly management summary",
    "for Peckers, a two-site fried-chicken business (Hitchin and Stevenage).",
    "",
    `Dashboard: ${input.dashboard}. Week starting: ${input.week}. ${scope}`,
    "",
    "Structured KPI facts (JSON):",
    JSON.stringify(input, null, 2),
    "",
    "A deterministic draft of the commentary (use it for tone and to anchor the numbers,",
    "but improve the prose and surface the most decision-useful insight):",
    JSON.stringify(draft, null, 2),
    "",
    "Write the response as JSON only, matching exactly:",
    '{ "summary": string (2-3 sentences), "bullets": string[] (3-5 short, action-oriented points) }',
    "Rules:",
    "- Use GBP (£) and show money to the penny exactly as given — NEVER round (write £14,645.00, not £14,645 or £15k).",
    "- Show unit/order counts exactly as given; do not round them.",
    "- Whenever you mention AOV, give Delivery AOV and In-store AOV separately (never a single unlabelled AOV).",
    "- Write in plain, story-telling English a non-technical owner can act on — not a bare list of numbers.",
    "- Do not invent figures. Return ONLY the JSON object.",
  ].join("\n");
}
