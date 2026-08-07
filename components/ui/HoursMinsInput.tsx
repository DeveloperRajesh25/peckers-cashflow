"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Two-box hours/minutes entry — [hr] [min] — for the few places a manager
 * types an hours correction (Daily Approval, Weekly Log).
 *
 * Deliberately NOT its own source of truth: `value`/`onChange` still speak the
 * exact "H.MM" string every caller already round-trips through
 * `parseHoursMinsInput` (see lib/utils.ts) — this component only changes the
 * widget, not the format. That keeps every downstream check (invalid-input
 * flag, the "effective hours" fallback to the clocked total, the wage/rollup
 * actions the value eventually feeds) untouched.
 *
 * The minute box holds the LITERAL minute value the user types, always
 * emitted as two digits (left-padded) — never the single-digit "×10" shorthand
 * `parseHoursMinsInput` accepts from free typing (that shorthand exists for a
 * single combined box; a box labelled "min" should mean exactly what it says).
 */
function splitValue(value: string): { h: string; m: string } {
  const dot = value.indexOf(".");
  if (dot === -1) return { h: value, m: "" };
  return { h: value.slice(0, dot), m: value.slice(dot + 1) };
}

/** The exact "H.MM" string every caller already parses — unchanged. */
function combine(h: string, m: string): string {
  if (h === "" && m === "") return "";
  const hh = h === "" ? "0" : h;
  const mm = m === "" ? "00" : m.padStart(2, "0");
  return `${hh}.${mm}`;
}

export function HoursMinsInput({
  value,
  onChange,
  invalid,
  hourAriaLabel,
  minAriaLabel,
  className,
}: {
  /** Current "H.MM" string — same value the surrounding code already holds. */
  value: string;
  /** Emits the same "H.MM" format; parse it exactly as before. */
  onChange: (next: string) => void;
  invalid?: boolean;
  hourAriaLabel: string;
  minAriaLabel: string;
  className?: string;
}) {
  // What the boxes SHOW is kept separately from the "H.MM" value they emit.
  // Emitting a left-padded minute ("3" → "0.03") and then reading it straight
  // back made the box full at one digit, so a second keystroke was truncated
  // away and a minute like 30 could never be typed.
  const [draft, setDraft] = React.useState(() => splitValue(value));
  const [lastValue, setLastValue] = React.useState(value);

  if (value !== lastValue) {
    setLastValue(value);
    // Only reset the boxes when the change came from OUTSIDE — our own emit
    // round-trips to the same string and must leave what's being typed alone.
    if (value !== combine(draft.h, draft.m)) setDraft(splitValue(value));
  }

  function handleHour(e: React.ChangeEvent<HTMLInputElement>) {
    const h = e.target.value.replace(/\D/g, "").slice(0, 3);
    setDraft((p) => ({ ...p, h }));
    onChange(combine(h, draft.m));
  }

  function handleMin(e: React.ChangeEvent<HTMLInputElement>) {
    let m = e.target.value.replace(/\D/g, "").slice(0, 2);
    if (m !== "" && Number(m) > 59) m = "59";
    setDraft((p) => ({ ...p, m }));
    onChange(combine(draft.h, m));
  }

  const boxClass = cn(
    "w-11 rounded-lg border bg-surface px-1.5 py-1 text-right text-sm tabular-nums outline-none focus:ring-2",
    invalid
      ? "border-danger focus:border-danger focus:ring-danger/30"
      : "border-border focus:border-gold/60 focus:ring-gold/30",
  );

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <input
        type="text"
        inputMode="numeric"
        value={draft.h}
        onChange={handleHour}
        aria-label={hourAriaLabel}
        className={boxClass}
      />
      <span className="text-[10px] text-text-muted">hr</span>
      <input
        type="text"
        inputMode="numeric"
        value={draft.m}
        onChange={handleMin}
        aria-label={minAriaLabel}
        className={boxClass}
      />
      <span className="text-[10px] text-text-muted">min</span>
    </span>
  );
}
