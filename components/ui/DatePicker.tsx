"use client";

import * as React from "react";
import {
  MONTH_LONG,
  WEEKDAY_SHORT,
  addDays,
  cn,
  formatDDMMYYYY,
  isSameDay,
  parseISODate,
  startOfISOWeek,
  startOfMonth,
  toISODate,
} from "@/lib/utils";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon } from "@/components/ui/icons";

type Props = {
  /** Selected date as YYYY-MM-DD (empty string for none). */
  value: string;
  /** Called with the new YYYY-MM-DD string (empty string when cleared). */
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Placeholder shown when no date is selected. */
  placeholder?: string;
  /** Disable selecting days before this YYYY-MM-DD. */
  min?: string;
  /** Disable selecting days after this YYYY-MM-DD. */
  max?: string;
  disabled?: boolean;
  containerClassName?: string;
  id?: string;
};

/**
 * Custom single-date picker shown as a calendar popover, styled to match the
 * project's Input/Select fields and gold theme. Drop-in replacement for the
 * native `<input type="date">` — takes/returns a YYYY-MM-DD string.
 */
export function DatePicker({
  value,
  onChange,
  label,
  hint,
  error,
  required,
  placeholder = "dd/mm/yyyy",
  min,
  max,
  disabled,
  containerClassName,
  id,
}: Props) {
  const autoId = React.useId();
  const fieldId = id ?? autoId;

  const [open, setOpen] = React.useState(false);
  const [flipUp, setFlipUp] = React.useState(false);
  // Drill-down level inside the popover: pick a day, a month, or a year. The
  // year grid makes far-back dates (e.g. dates of birth in the 1990s) reachable
  // in a couple of clicks instead of paging month-by-month.
  const [view, setView] = React.useState<"days" | "months" | "years">("days");
  const [yearStart, setYearStart] = React.useState(2000);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const selected = value ? parseISODate(value) : null;
  const minDate = min ? parseISODate(min) : null;
  const maxDate = max ? parseISODate(max) : null;

  // Month currently shown in the grid — follows the selected value, else today.
  const [viewMonth, setViewMonth] = React.useState(() =>
    startOfMonth(selected && !isNaN(selected.getTime()) ? selected : new Date()),
  );

  // Re-sync the visible month whenever the popover opens.
  React.useEffect(() => {
    if (open) {
      const base = value ? parseISODate(value) : new Date();
      const start = startOfMonth(isNaN(base.getTime()) ? new Date() : base);
      setViewMonth(start);
      setView("days");
      // Show a 12-year block containing the focused year.
      setYearStart(start.getFullYear() - (start.getFullYear() % 12));
      // Flip the popover above the field if there isn't room below.
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setFlipUp(window.innerHeight - rect.bottom < 380);
    }
  }, [open, value]);

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

  function isDisabled(d: Date) {
    if (minDate && !isNaN(minDate.getTime()) && d.getTime() < startOfDayMs(minDate)) return true;
    if (maxDate && !isNaN(maxDate.getTime()) && d.getTime() > startOfDayMs(maxDate)) return true;
    return false;
  }

  function pick(d: Date) {
    if (isDisabled(d)) return;
    onChange(toISODate(d));
    setOpen(false);
  }

  // Build the 6-row month grid (leading Monday padding).
  const monthStart = startOfMonth(viewMonth);
  const gridStart = startOfISOWeek(monthStart);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  const today = new Date();

  return (
    <div className={cn("flex flex-col gap-1.5 min-w-0", containerClassName)}>
      {label && (
        <label htmlFor={fieldId} className="text-sm font-medium text-text-subtle">
          {label}
          {required && <span className="text-danger"> *</span>}
        </label>
      )}

      <div ref={wrapRef} className="relative">
        <button
          id={fieldId}
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={cn(
            "flex items-center gap-2 w-full rounded-xl bg-surface border border-border px-3 h-11 transition-colors text-left",
            "hover:bg-surface-hover focus:outline-none focus-visible:border-gold/60 focus-visible:ring-2 focus-visible:ring-gold/30",
            open && "border-gold/60 ring-2 ring-gold/30",
            error && "border-danger/60",
            disabled && "opacity-50 cursor-not-allowed",
          )}
        >
          <CalendarIcon size={16} className="text-text-muted shrink-0" />
          <span
            className={cn(
              "flex-1 text-sm truncate",
              selected ? "text-text-primary" : "text-text-muted",
            )}
          >
            {selected ? formatDDMMYYYY(selected) : placeholder}
          </span>
          <ChevronDownIcon
            size={16}
            className={cn(
              "text-text-muted shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {open && (
          <div
            role="dialog"
            className={cn(
              "absolute left-0 z-40 w-[min(18rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface shadow-xl p-3 animate-fade-in",
              flipUp ? "bottom-full mb-2" : "top-full mt-2",
            )}
          >
            {/* Header nav — adapts to the drill-down level (day / month / year) */}
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => {
                  if (view === "days")
                    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
                  else if (view === "months")
                    setViewMonth((m) => new Date(m.getFullYear() - 1, m.getMonth(), 1));
                  else setYearStart((y) => y - 12);
                }}
                className="h-8 w-8 grid place-items-center rounded-lg hover:bg-surface-hover text-text-subtle"
                aria-label="Previous"
              >
                <ChevronLeftIcon size={16} />
              </button>
              <button
                type="button"
                onClick={() =>
                  setView(view === "days" ? "months" : view === "months" ? "years" : "days")
                }
                className="text-sm font-medium text-text-primary px-3 h-8 rounded-lg hover:bg-surface-hover transition-colors"
                title="Switch between day, month and year"
              >
                {view === "days" && `${MONTH_LONG[viewMonth.getMonth()]} ${viewMonth.getFullYear()}`}
                {view === "months" && viewMonth.getFullYear()}
                {view === "years" && `${yearStart} – ${yearStart + 11}`}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (view === "days")
                    setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
                  else if (view === "months")
                    setViewMonth((m) => new Date(m.getFullYear() + 1, m.getMonth(), 1));
                  else setYearStart((y) => y + 12);
                }}
                className="h-8 w-8 grid place-items-center rounded-lg hover:bg-surface-hover text-text-subtle"
                aria-label="Next"
              >
                <ChevronRightIcon size={16} />
              </button>
            </div>

            {view === "days" && (
              <>
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
                    const isSel = selected ? isSameDay(d, selected) : false;
                    const off = isDisabled(d);
                    return (
                      <button
                        key={toISODate(d)}
                        type="button"
                        disabled={off}
                        onClick={() => pick(d)}
                        className="h-9 grid place-items-center"
                      >
                        <span
                          className={cn(
                            "h-8 w-8 grid place-items-center rounded-lg text-xs transition-colors",
                            isSel
                              ? "bg-gold text-black font-semibold"
                              : off
                                ? "text-text-muted/40 cursor-not-allowed"
                                : outside
                                  ? "text-text-muted/50 hover:bg-surface-hover"
                                  : "text-text-primary hover:bg-surface-hover",
                            isToday && !isSel && "ring-1 ring-gold/50",
                          )}
                        >
                          {d.getDate()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {view === "months" && (
              <div className="grid grid-cols-3 gap-1.5 py-1">
                {MONTH_LONG.map((label, idx) => {
                  const isSel =
                    !!selected &&
                    selected.getMonth() === idx &&
                    selected.getFullYear() === viewMonth.getFullYear();
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setViewMonth((m) => new Date(m.getFullYear(), idx, 1));
                        setView("days");
                      }}
                      className={cn(
                        "h-10 rounded-lg text-xs transition-colors",
                        isSel
                          ? "bg-gold text-black font-semibold"
                          : "text-text-primary hover:bg-surface-hover",
                      )}
                    >
                      {label.slice(0, 3)}
                    </button>
                  );
                })}
              </div>
            )}

            {view === "years" && (
              <div className="grid grid-cols-3 gap-1.5 py-1">
                {Array.from({ length: 12 }, (_, i) => yearStart + i).map((yr) => {
                  const isSel = !!selected && selected.getFullYear() === yr;
                  return (
                    <button
                      key={yr}
                      type="button"
                      onClick={() => {
                        setViewMonth((m) => new Date(yr, m.getMonth(), 1));
                        setView("months");
                      }}
                      className={cn(
                        "h-10 rounded-lg text-xs transition-colors",
                        isSel
                          ? "bg-gold text-black font-semibold"
                          : "text-text-primary hover:bg-surface-hover",
                      )}
                    >
                      {yr}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Footer actions */}
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => pick(today)}
                disabled={isDisabled(today)}
                className="text-xs font-medium text-gold hover:text-gold-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Today
              </button>
            </div>
          </div>
        )}
      </div>

      {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function startOfDayMs(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
