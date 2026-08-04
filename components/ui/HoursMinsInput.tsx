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
  const dot = value.indexOf(".");
  const hourStr = dot === -1 ? value : value.slice(0, dot);
  const minStr = dot === -1 ? "" : value.slice(dot + 1);

  function combine(h: string, m: string): string {
    if (h === "" && m === "") return "";
    const hh = h === "" ? "0" : h;
    const mm = m === "" ? "00" : m.padStart(2, "0");
    return `${hh}.${mm}`;
  }

  function handleHour(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, "").slice(0, 3);
    onChange(combine(digits, minStr));
  }

  function handleMin(e: React.ChangeEvent<HTMLInputElement>) {
    let digits = e.target.value.replace(/\D/g, "").slice(0, 2);
    if (digits !== "" && Number(digits) > 59) digits = "59";
    onChange(combine(hourStr, digits));
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
        value={hourStr}
        onChange={handleHour}
        aria-label={hourAriaLabel}
        className={boxClass}
      />
      <span className="text-[10px] text-text-muted">hr</span>
      <input
        type="text"
        inputMode="numeric"
        value={minStr}
        onChange={handleMin}
        aria-label={minAriaLabel}
        className={boxClass}
      />
      <span className="text-[10px] text-text-muted">min</span>
    </span>
  );
}
