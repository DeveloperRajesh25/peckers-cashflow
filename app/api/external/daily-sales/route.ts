// =============================================================
// Read-only daily sales feed for other Peckers apps.
//
// Exists so the sauce app (peckers-sms) can show a store's sales for the day
// without re-typing the number a manager already recorded here. It lives on a
// different Supabase project, so a direct table read isn't an option.
//
// Auth: `Authorization: Bearer <EXTERNAL_API_SECRET>`. Unlike the cron routes
// this deliberately does NOT accept the secret as a query param — those URLs
// end up in access logs.
//
// GET /api/external/daily-sales?date=YYYY-MM-DD   (default: today in London)
//   -> { date, stores: [{ storeId, storeName, sales }] }
// Stores with no entry for that date are simply absent from the array.
// =============================================================

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in Europe/London — the server clock runs on UTC. */
function londonToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function authorized(req: Request): boolean {
  const secret = process.env.EXTERNAL_API_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const requested = new URL(req.url).searchParams.get("date");
  if (requested && !ISO_DATE.test(requested)) {
    return NextResponse.json(
      { ok: false, error: "Invalid date — expected YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const date = requested ?? londonToday();

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("daily_cash_entries")
    .select("store_id, vita_mojo_sales, stores(id, name)")
    .eq("entry_date", date);

  if (error) {
    console.error("[external/daily-sales] query error:", error.message);
    return NextResponse.json({ ok: false, error: "Query failed" }, { status: 500 });
  }

  const stores = (data ?? []).map((row) => {
    // The embedded relation comes back as an object, but the generated types
    // widen it to an array — normalise both shapes.
    const store = Array.isArray(row.stores) ? row.stores[0] : row.stores;
    return {
      storeId: row.store_id,
      storeName: (store as { name?: string } | null)?.name ?? null,
      sales: Number(row.vita_mojo_sales ?? 0),
    };
  });

  return NextResponse.json({ ok: true, date, stores });
}
