"use client";

// =============================================================
// The date control every panel on /employee/analytics carries.
//
// Each panel keeps its own window in the URL, because the window decides which
// rows the SERVER has to fetch — a client-side change would have no data to
// show. One param per panel, so moving the deliveries window doesn't disturb
// the charts above it.
//
// <input type="date">, never type="week" or type="month": both are unsupported
// in Safari and Firefox, and crew are overwhelmingly on phones. Whatever day
// the employee taps is snapped back to its Monday (or the 1st of its month).
// =============================================================

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

type Props = {
  /** URL param this control owns, e.g. "w" for the week-by-week chart. */
  param: string;
  /** "week" steps by 7 days and snaps to Monday; "month" steps by a month. */
  unit: "week" | "month";
  /** Currently selected anchor — the NEWEST week/month in the panel's range. */
  anchor: string;
  minAnchor: string;
  maxAnchor: string;
  /** Human range, shown between the arrows: "7 Jul – 3 Aug". */
  label: string;
  /** Optional span selector (the deliveries panel picks how many weeks). */
  span?: {
    param: string;
    value: number;
    options: number[];
  };
};

function toIso(d: Date) {
  const y = d.getFullYear();
  return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIso(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function snap(d: Date, unit: "week" | "month") {
  if (unit === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return new Date(copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7)));
}

function step(iso: string, unit: "week" | "month", direction: 1 | -1) {
  const d = parseIso(iso);
  if (unit === "month") return toIso(new Date(d.getFullYear(), d.getMonth() + direction, 1));
  return toIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * direction));
}

export function AnalyticsRangePicker({
  param,
  unit,
  anchor,
  minAnchor,
  maxAnchor,
  label,
  span,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // useTransition, not a boolean: the flag has to clear itself when the new
  // window's server render arrives, or the buttons stay disabled forever.
  const [pending, startTransition] = React.useTransition();

  function push(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) params.set(k, v);
    startTransition(() => {
      router.push(`/employee/analytics?${params.toString()}`, { scroll: false });
    });
  }

  function goTo(iso: string) {
    if (iso < minAnchor || iso > maxAnchor) return;
    push({ [param]: iso });
  }

  const dateRef = React.useRef<HTMLInputElement>(null);

  /**
   * Open the native calendar. showPicker() is the only reliable way to do this
   * from a click that isn't on the field's own icon; it throws when the browser
   * doesn't support it (or refuses the activation), so focus+click remains as
   * the fallback — which is what opens the picker on iOS and Android anyway.
   */
  function openPicker(fromInput = false) {
    const el = dateRef.current;
    if (!el || pending) return;
    try {
      el.showPicker();
      return;
    } catch {
      // Unsupported or blocked — fall through.
    }
    // Only synthesise a click when the call came from the BUTTON (keyboard).
    // Doing it from the input's own handler would re-enter this function and
    // loop forever; the browser is already handling that click natively.
    if (fromInput) return;
    el.focus();
    el.click();
  }

  const canGoBack = anchor > minAnchor;
  const canGoForward = anchor < maxAnchor;

  // The input's bounds are the LAST DAY of the newest selectable period, not
  // its anchor: on the 3rd of the month the anchor is the 1st, and capping the
  // calendar there would stop the employee tapping today to mean "this month".
  const max = parseIso(maxAnchor);
  const inputMax =
    unit === "month"
      ? toIso(new Date(max.getFullYear(), max.getMonth() + 1, 0))
      : toIso(new Date(max.getFullYear(), max.getMonth(), max.getDate() + 6));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        disabled={!canGoBack || pending}
        onClick={() => goTo(step(anchor, unit, -1))}
        aria-label={`Previous ${unit}`}
      >
        <ChevronLeftIcon size={14} />
      </Button>

      <span className="text-xs text-text-muted tabular-nums px-1 min-w-0">{label}</span>

      <Button
        variant="secondary"
        size="sm"
        disabled={!canGoForward || pending}
        onClick={() => goTo(step(anchor, unit, 1))}
        aria-label={`Next ${unit}`}
      >
        <ChevronRightIcon size={14} />
      </Button>

      {/* The calendar.
          A transparent <input type="date"> laid over a button is NOT enough on
          its own: on desktop, clicking a date field only focuses it — the
          calendar opens solely from the field's own icon, which is invisible
          here. So the click explicitly calls showPicker(). The input stays
          rendered (opacity, never `hidden`) because showPicker() throws on an
          element that isn't being rendered, and because tapping it is what
          opens the picker on phones, where showPicker may be missing. */}
      <div className="relative inline-flex">
        <button
          type="button"
          onClick={() => openPicker(false)}
          disabled={pending}
          className={cn(
            "inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-border",
            "text-xs text-text-muted hover:text-text-primary hover:bg-surface-hover",
            "focus:outline-none focus:ring-2 focus:ring-gold/30",
            pending && "opacity-60",
          )}
          aria-label={`Pick a ${unit}`}
        >
          <CalendarIcon size={14} />
          <span className="hidden sm:inline">Pick</span>
        </button>
        <input
          ref={dateRef}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          value={anchor}
          min={minAnchor}
          max={inputMax}
          onClick={() => openPicker(true)}
          onChange={(e) => {
            if (!e.target.value) return;
            const picked = parseIso(e.target.value);
            if (isNaN(picked.getTime())) return;
            const next = toIso(snap(picked, unit));
            if (next === anchor) {
              // Another day inside the SAME window. No state changes, so React
              // won't re-render — put the field back on the anchor by hand or
              // the calendar reopens on the stray date next time.
              e.target.value = anchor;
              return;
            }
            goTo(next);
          }}
        />
      </div>

      {span && (
        <select
          value={span.value}
          disabled={pending}
          onChange={(e) => push({ [span.param]: e.target.value })}
          className="h-9 rounded-lg border border-border bg-surface px-2 text-xs text-text-primary"
          aria-label="How many weeks"
        >
          {span.options.map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? "week" : "weeks"}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
