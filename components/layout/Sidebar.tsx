"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import { NAV_FOR_PORTAL } from "./nav-config";
import type { Portal } from "@/lib/types";

const PORTAL_TAG: Record<Portal, string> = {
  admin: "Admin",
  manager: "Manager",
  employee: "Crew",
  cover_driver: "Cover Driver",
};

export function Sidebar({ portal, userName }: { portal: Portal; userName?: string | null }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState(false);
  const items = NAV_FOR_PORTAL[portal];
  const initials = (userName ?? "")
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col border-r border-border bg-bg sticky top-0 h-screen transition-all duration-200",
        collapsed ? "w-[64px]" : "w-[220px]",
      )}
    >
      <div
        className={cn(
          "flex items-center h-16 px-3 border-b border-border",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        <Logo compact={collapsed} />
        <button
          onClick={() => setCollapsed((c) => !c)}
          className={cn(
            "h-8 w-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface",
            collapsed && "absolute right-2",
          )}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
        </button>
      </div>

      <nav className="flex-1 p-2 flex flex-col gap-1 overflow-y-auto">
        {items.map((item, idx) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || pathname?.startsWith(item.href + "/");
          const prev = items[idx - 1];
          const showGroupLabel = !collapsed && item.group && prev?.group !== item.group;
          return (
            <React.Fragment key={item.href}>
              {showGroupLabel && (
                <p className="px-3 mt-2 mb-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                  {item.group}
                </p>
              )}
              <Link
                href={item.href}
                className={cn(
                  "group relative flex items-center gap-3 h-11 px-3 rounded-xl text-sm transition-colors",
                  active
                    ? "bg-surface text-text-primary"
                    : "text-text-muted hover:text-text-primary hover:bg-surface/60",
                  collapsed && "justify-center px-0",
                )}
              >
                {active && (
                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-gold" />
                )}
                <Icon size={collapsed ? 20 : 18} />
                {!collapsed && <span className="font-medium">{item.label}</span>}
              </Link>
            </React.Fragment>
          );
        })}
      </nav>

      {/* Signed-in user */}
      {userName && (
        <div
          className={cn(
            "px-3 pt-3 flex items-center gap-2",
            collapsed ? "justify-center" : "justify-start",
          )}
        >
          <span className="h-8 w-8 shrink-0 rounded-full bg-gold/15 text-gold border border-gold/30 flex items-center justify-center text-xs font-semibold">
            {initials || "•"}
          </span>
          {!collapsed && (
            <span className="text-sm font-medium text-text-primary truncate" title={userName}>
              {userName}
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          "p-3 border-t border-border mt-2 flex items-center gap-2",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed && (
          <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">
            {PORTAL_TAG[portal]}
          </p>
        )}
        <ThemeToggle variant="icon" />
      </div>
    </aside>
  );
}
