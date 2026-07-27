import { buildInsights, buildClaudePrompt, type InsightInput } from "@/lib/vm-analytics/insights";
import { getVMSupabaseServer } from "@/lib/vm-analytics/client";
import type { Insight } from "@/lib/vm-analytics/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-dashboard cache version. Present only for dashboards whose commentary
// data definition has changed; absent dashboards keep the unversioned key.
const CACHE_VERSIONS: Partial<Record<InsightInput["dashboard"], string>> = {
  // products=v4: top-category share switched from % of category revenue to
  // % of total net sales (Update 29), so v3 rows quote the wrong percentage.
  products: "v4",
  // daypart=v2: hourly Revenue/AOV moved from gross to net (Update 28). Rows
  // cached before the vm_net_sales_by_hour backfill completed hold "£0.00" and
  // were still being served long after the data landed.
  daypart: "v2",
};

export async function POST(req: Request): Promise<Response> {
  let input: InsightInput;
  try {
    const body = await req.json();
    input = body.input as InsightInput;
    if (!input || !input.dashboard) throw new Error("missing input.dashboard");
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Cache discriminator: store-specific dashboards send a `store`, so the
  // commentary must be cached per store (otherwise the first store viewed that
  // week is served for every store). All-Stores views send no store and keep
  // the plain dashboard key. Stored in the `dashboard` column, e.g.
  // "delivery" (all) vs "delivery@Peckers Hitchin".
  //
  // Bump the version when the commentary's underlying data changes so stale
  // pre-change rows stop matching and regenerate from the corrected input.
  const version = CACHE_VERSIONS[input.dashboard];
  const base = input.store ? `${input.dashboard}@${input.store}` : input.dashboard;
  const cacheKey = version ? `${base}#${version}` : base;

  // ── Step 1: Cache check ────────────────────────────────────────────────────
  // If a summary for this (week, cacheKey) pair already exists, return it
  // immediately — no Claude call, no cost.
  try {
    const sb = getVMSupabaseServer();
    const { data: cached } = await sb
      .from("vm_generated_insights")
      .select("summary, bullets, source")
      .eq("week_start_iso", input.week)
      .eq("dashboard", cacheKey)
      .single();

    if (cached?.summary) {
      return Response.json({
        source: cached.source as "claude" | "rules",
        summary: cached.summary as string,
        bullets: cached.bullets as string[],
      } satisfies Insight);
    }
  } catch {
    // Table missing or network error — treat as cache miss, continue.
  }

  // ── Step 2: Generate (Claude if key present, otherwise rule-based) ─────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let insight: Insight;

  if (!apiKey) {
    insight = buildInsights(input);
  } else {
    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey });
      const model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

      const msg = await client.messages.create({
        model,
        max_tokens: 700,
        messages: [{ role: "user", content: buildClaudePrompt(input) }],
      });

      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      const json = extractJson(text);
      if (json && typeof json.summary === "string" && Array.isArray(json.bullets)) {
        insight = {
          source: "claude",
          summary: json.summary,
          bullets: json.bullets.map(String),
        };
      } else {
        insight = buildInsights(input);
      }
    } catch (err) {
      console.error("[insights] Claude call failed, falling back to rules:", err);
      insight = buildInsights(input);
    }
  }

  // The Executive dashboard intentionally has no narrative summary (the KPI
  // cards carry the story). Enforce it here so the Claude path can't reintroduce
  // one, and the empty summary is what gets cached.
  if (input.dashboard === "executive") {
    insight = { ...insight, summary: "" };
  }

  // ── Step 3: Persist to cache (fire-and-forget, non-fatal) ─────────────────
  // The next user to open this (week, dashboard) gets the cached result —
  // no API call and no delay regardless of how many times they switch weeks.
  try {
    const sb = getVMSupabaseServer();
    await sb.from("vm_generated_insights").upsert(
      {
        week_start_iso: input.week,
        dashboard: cacheKey,
        summary: insight.summary,
        bullets: insight.bullets,
        source: insight.source,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "week_start_iso,dashboard" }
    );
  } catch (err) {
    console.warn("[insights] Cache write failed (non-fatal):", err);
  }

  return Response.json(insight satisfies Insight);
}

function extractJson(text: string): { summary?: unknown; bullets?: unknown } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
