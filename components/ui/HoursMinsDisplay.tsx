import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A worked-hours total shown as two small boxes — [4] hr [30] min — instead of
 * the "4.30" decimal-looking notation. Purely presentational: the underlying
 * value and every calculation built on it are unchanged, this only changes how
 * it's read on screen. Pairs with `formatHoursMinsWords` for the plain-text
 * equivalent used in tooltips and toasts, where two boxes can't render.
 */
export function HoursMinsDisplay({
  hours,
  size = "sm",
  className,
  inline = true,
}: {
  hours: number | null | undefined;
  /** "sm" fits a table cell/badge; "md" is for a standalone total. */
  size?: "sm" | "md";
  className?: string;
  /** False drops the wrapper's inline-flex so it can sit inside a <p> cleanly. */
  inline?: boolean;
}) {
  const totalMinutes = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  const box =
    size === "md"
      ? "px-2 py-1 text-base"
      : "px-1.5 py-0.5 text-xs";
  const label = size === "md" ? "text-[11px]" : "text-[9px]";

  return (
    <span
      className={cn(
        inline ? "inline-flex" : "flex",
        "items-center gap-1 align-middle",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-baseline gap-1 rounded-md border border-border bg-surface-hover font-semibold tabular-nums text-text-primary",
          box,
        )}
      >
        {h}
        <span className={cn("font-normal text-text-muted", label)}>hr</span>
      </span>
      <span
        className={cn(
          "inline-flex items-baseline gap-1 rounded-md border border-border bg-surface-hover font-semibold tabular-nums text-text-primary",
          box,
        )}
      >
        {String(m).padStart(2, "0")}
        <span className={cn("font-normal text-text-muted", label)}>min</span>
      </span>
    </span>
  );
}
