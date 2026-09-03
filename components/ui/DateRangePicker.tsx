"use client";

import * as React from "react";
import {
  MONTH_LONG,
  WEEKDAY_SHORT,
  addDays,
  endOfISOWeek,
  endOfMonth,
  formatDDMMYYYY,
  isSameDay,
  parseISODate,
  startOfDay,
  startOfISOWeek,
  startOfMonth,
  toISODate,
} from "@/lib/utils";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";

type Props = {
  /** Current range start (YYYY-MM-DD). */
  start: string;
  /** Current range end (YYYY-MM-DD). */
  end: string;
  /** Called when the user confirms a new range. */
  onApply: (start: string, end: string) => void;
};

/**
 * Custom date-range picker shown as a calendar popover. The trigger displays
 * the active range; opening it reveals a month grid where the manager taps a
 * start day then an end day (any two dates — not limited to a single week).
 * Quick presets cover the common "this week / this month" cases.
 */
export function DateRangePicker({ start, end, onApply }: Props) {
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // The month currently shown in the grid.
  const [viewMonth, setViewMonth] = React.useState(() =>
    startOfMonth(parseISODate(start)),
  );
  // Selection in progress: anchor is the first click, hover previews the range.
  const [anchor, setAnchor] = React.useState<Date | null>(null);
  const [hover, setHover] = React.useState<Date | null>(null);

  const selStart = parseISODate(start);
  const selEnd = parseISODate(end);

  // Reset transient state whenever the popover opens.
  React.useEffect(() => {
    if (open) {
      setViewMonth(startOfMonth(parseISODate(start)));
      setAnchor(null);
      setHover(null);
    }
  }, [open, start]);

  // Close on outside click / Escape.
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function commit(a: Date, b: Date) {
    const lo = a.getTime() <= b.getTime() ? a : b;
    const hi = a.getTime() <= b.getTime() ? b : a;
    onApply(toISODate(lo), toISODate(hi));
    setOpen(false);
    setAnchor(null);
    setHover(null);
  }

  function pickDay(d: Date) {
    if (!anchor) {
      // First click: set the anchor and wait for the second.
      setAnchor(d);
      setHover(d);
    } else {
      // Second click: commit the range.
      commit(anchor, d);
    }
  }

  function applyPreset(a: Date, b: Date) {
    commit(a, b);
  }

  // Build the 6-row month grid (leading Monday padding).
  const monthStart = startOfMonth(viewMonth);
  const gridStart = startOfISOWeek(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  // Range used for highlighting: while picking, preview anchor→hover.
  const previewLo = anchor
    ? (hover && hover.getTime() < anchor.getTime() ? hover : anchor)
    : selStart;
  const previewHi = anchor
    ? (hover && hover.getTime() >= anchor.getTime() ? hover : anchor)
    : selEnd;

  function inRange(d: Date) {
    const t = startOfDay(d).getTime();
    return t >= startOfDay(previewLo).getTime() && t <= startOfDay(previewHi).getTime();
  }

  const today = new Date();

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 h-11 px-3 rounded-xl border border-border bg-surface hover:bg-surface-hover transition-colors text-left"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CalendarIcon size={16} className="text-text-muted shrink-0" />
        <span className="leading-tight">
          <span className="block text-[10px] text-text-muted uppercase tracking-wider">
            Date range
          </span>
          <span className="block text-sm font-medium text-text-primary">
            {formatDDMMYYYY(selStart)} – {formatDDMMYYYY(selEnd)}
          </span>
        </span>
        <ChevronRightIcon
          size={14}
          className={"text-text-muted shrink-0 transition-transform " + (open ? "rotate-90" : "rotate-0")}
        />
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-xl p-3"
        >
          {/* Presets */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[
              {
                label: "This week",
                a: startOfISOWeek(today),
                b: endOfISOWeek(today),
              },
              {
                label: "Next week",
                a: startOfISOWeek(addDays(today, 7)),
                b: endOfISOWeek(addDays(today, 7)),
              },
              {
                label: "Last week",
                a: startOfISOWeek(addDays(today, -7)),
                b: endOfISOWeek(addDays(today, -7)),
              },
              {
                label: "This month",
                a: startOfMonth(today),
                b: endOfMonth(today),
              },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p.a, p.b)}
                className="px-2.5 h-7 rounded-lg border border-border text-xs text-text-subtle hover:bg-surface-hover hover:text-text-primary transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Month nav */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="h-8 w-8 grid place-items-center rounded-lg hover:bg-surface-hover text-text-subtle"
              aria-label="Previous month"
            >
              <ChevronLeftIcon size={16} />
            </button>
            <div className="text-sm font-medium text-text-primary">
              {MONTH_LONG[viewMonth.getMonth()]} {viewMonth.getFullYear()}
            </div>
            <button
              type="button"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="h-8 w-8 grid place-items-center rounded-lg hover:bg-surface-hover text-text-subtle"
              aria-label="Next month"
            >
              <ChevronRightIcon size={16} />
            </button>
          </div>

          {/* Weekday header */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_SHORT.map((w) => (
              <div
                key={w}
                className="text-center text-[10px] uppercase tracking-wider text-text-muted py-1"
              >
                {w[0]}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((d) => {
              const outside = d.getMonth() !== viewMonth.getMonth();
              const isToday = isSameDay(d, today);
              const selected = inRange(d);
              const isLo = isSameDay(d, previewLo);
              const isHi = isSameDay(d, previewHi);
              const isEnd = isLo || isHi;
              return (
                <button
                  key={toISODate(d)}
                  type="button"
                  onClick={() => pickDay(d)}
                  onMouseEnter={() => anchor && setHover(d)}
                  className={
                    "h-9 text-xs relative transition-colors " +
                    (selected && !isEnd ? "bg-gold/15 " : "") +
                    (isLo && !isSameDay(previewLo, previewHi) ? "rounded-l-lg " : "") +
                    (isHi && !isSameDay(previewLo, previewHi) ? "rounded-r-lg " : "") +
                    (isSameDay(previewLo, previewHi) && isEnd ? "rounded-lg " : "")
                  }
                >
                  <span
                    className={
                      "absolute inset-0 m-auto h-8 w-8 grid place-items-center rounded-lg " +
                      (isEnd
                        ? "bg-gold text-black font-semibold"
                        : selected
                          ? "text-text-primary"
                          : outside
                            ? "text-text-muted/50 hover:bg-surface-hover"
                            : "text-text-primary hover:bg-surface-hover") +
                      (isToday && !isEnd ? " ring-1 ring-gold/50" : "")
                    }
                  >
                    {d.getDate()}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-2 text-[11px] text-text-muted text-center">
            {anchor
              ? "Now pick the end date"
              : "Tap a start date, then an end date"}
          </p>
        </div>
      )}
    </div>
  );
}
