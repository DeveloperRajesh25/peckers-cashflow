"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type TabItem = {
  id: string;
  label: string;
  /** Optional count shown as a pill (e.g. pending approvals). Hidden when 0/null. */
  badge?: number | null;
  icon?: React.ReactNode;
};

/**
 * Segmented tab bar styled to match the app's gold theme. Controlled: the parent
 * owns the active id and re-renders the matching panel itself.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Sections"
      className={cn(
        "inline-flex items-center gap-1 p-1 rounded-xl bg-surface border border-border max-w-full min-w-0 overflow-x-auto scrollbar-none",
        className,
      )}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 px-3 sm:px-4 h-10 rounded-lg text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-gold text-black shadow-sm"
                : "text-text-subtle hover:text-text-primary hover:bg-surface-hover",
            )}
          >
            {t.icon}
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold tabular-nums",
                  active ? "bg-black/20 text-black" : "bg-gold/15 text-gold",
                )}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
