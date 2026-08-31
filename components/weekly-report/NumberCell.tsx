"use client";

import * as React from "react";

/**
 * The one numeric input every weekly-report sheet types into.
 *
 * Two things it fixes that a bare <input type="number"> gets wrong on a grid
 * this dense:
 *
 * 1. A stored zero renders as "0", so typing 345 into a prefilled cell used to
 *    give 0345 — the manager had to delete the zero first. Focusing SELECTS the
 *    whole value, so the first keystroke replaces it. The mouse-up guard is
 *    load-bearing: the click that focuses the field would otherwise collapse
 *    that selection to a caret before the manager types.
 * 2. A number input answers the mouse wheel, silently retyping money on a
 *    scroll, and the up/down arrows do the same on a grid navigated by keyboard.
 */
/**
 * Focus a money field and its whole value is selected, so the first keystroke
 * replaces it instead of typing into the existing digits. The mouse-up guard is
 * load-bearing: the click that focused the field would otherwise collapse the
 * selection to a caret before the manager types.
 */
export function useSelectOnFocus() {
  const armed = React.useRef(false);
  return {
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      armed.current = true;
      e.currentTarget.select();
    },
    onMouseUp: (e: React.MouseEvent<HTMLInputElement>) => {
      if (!armed.current) return;
      armed.current = false;
      e.preventDefault();
    },
    onBlur: () => {
      armed.current = false;
    },
  };
}

export function NumberCell({
  value,
  onValueChange,
  onCommit,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
  onCommit?: () => void;
}) {
  const select = useSelectOnFocus();

  return (
    <input
      {...props}
      type="number"
      inputMode="decimal"
      className={className}
      value={value}
      onFocus={(e) => {
        select.onFocus(e);
        props.onFocus?.(e);
      }}
      onMouseUp={(e) => {
        select.onMouseUp(e);
        props.onMouseUp?.(e);
      }}
      onWheel={(e) => e.currentTarget.blur()}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
        props.onKeyDown?.(e);
      }}
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={(e) => {
        select.onBlur();
        onCommit?.();
        props.onBlur?.(e);
      }}
    />
  );
}

function holdsFocus(el: HTMLElement | null): boolean {
  return !!el && typeof document !== "undefined" && el.contains(document.activeElement);
}

/**
 * Server data wins — but never mid-keystroke.
 *
 * Every cell saves on blur and then refreshes, so fresh rows land while the
 * manager is already typing in the NEXT cell. Re-seeding the drafts then wipes
 * what they have half-typed and snaps the cell back to the stored value, which
 * on a prefilled sheet reads as "it keeps putting a 0 back". Hold the update
 * until focus leaves the grid, then apply it.
 */
export function useDeferredSync(signature: string, apply: () => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  const applyRef = React.useRef(apply);
  applyRef.current = apply;
  const pending = React.useRef(false);

  React.useEffect(() => {
    if (holdsFocus(ref.current)) {
      pending.current = true;
      return;
    }
    applyRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Focus moving between two cells fires blur before the next focus lands, so
  // the check has to wait a tick to know whether the grid was really left.
  const onBlurCapture = React.useCallback(() => {
    window.setTimeout(() => {
      if (!pending.current || holdsFocus(ref.current)) return;
      pending.current = false;
      applyRef.current();
    }, 0);
  }, []);

  return { ref, onBlurCapture };
}
