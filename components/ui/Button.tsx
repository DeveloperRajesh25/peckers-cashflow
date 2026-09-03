"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
};

const variants: Record<Variant, string> = {
  primary:
    "bg-gold text-black hover:bg-gold-300 active:scale-[.98] focus:ring-2 focus:ring-gold/50",
  secondary:
    "bg-surface text-text-primary border border-border hover:bg-surface-hover focus:ring-2 focus:ring-gold/30",
  ghost:
    "bg-transparent text-text-primary hover:bg-surface-hover focus:ring-2 focus:ring-gold/30",
  outline:
    "bg-transparent text-text-primary border border-border hover:bg-surface focus:ring-2 focus:ring-gold/30",
  danger:
    "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25 focus:ring-2 focus:ring-danger/30",
};

// min-h, not h: a long label on a narrow phone wraps to a second line, and a
// fixed height pushes that line outside the button box.
const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3 py-1.5 text-sm",
  md: "min-h-11 px-4 py-2 text-sm",
  lg: "min-h-12 px-5 py-2.5 text-base",
  icon: "h-10 w-10 shrink-0 p-0",
};

export const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(
  {
    className,
    variant = "primary",
    size = "md",
    loading,
    iconLeft,
    iconRight,
    children,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn("btn-base outline-none", variants[variant], sizes[size], className)}
      {...props}
    >
      {loading ? (
        <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        iconLeft && <span className="shrink-0 inline-flex">{iconLeft}</span>
      )}
      {children != null && children !== false && (
        <span className="min-w-0 break-words">{children}</span>
      )}
      {!loading && iconRight && <span className="shrink-0 inline-flex">{iconRight}</span>}
    </button>
  );
});
