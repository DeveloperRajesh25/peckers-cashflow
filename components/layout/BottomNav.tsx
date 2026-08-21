"use client";

import { usePathname } from "next/navigation";
import * as React from "react";
import { cn } from "@/lib/utils";
import { NavLink } from "./NavLink";
import { BOTTOM_NAV_FOR_PORTAL, NAV_FOR_PORTAL } from "./nav-config";
import { CloseIcon, MoreIcon } from "@/components/ui/icons";
import type { Portal } from "@/lib/types";

function isActive(pathname: string | null, href: string) {
  return pathname === href || pathname?.startsWith(href + "/");
}

export function BottomNav({ portal }: { portal: Portal }) {
  const pathname = usePathname();
  const fullNav = NAV_FOR_PORTAL[portal];
  const primary = BOTTOM_NAV_FOR_PORTAL[portal];
  // Only add a "More" tab when the full menu doesn't already fit in the bar.
  const needsMore = fullNav.length > primary.length;

  const [sheetOpen, setSheetOpen] = React.useState(false);

  // Close the sheet whenever navigation happens (route changes).
  React.useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  // Lock body scroll while the sheet is open.
  React.useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sheetOpen]);

  const columns = primary.length + (needsMore ? 1 : 0);
  // A page is "in the More sheet" (not a primary tab) — used to light up the
  // More tab when you're on one of those pages.
  const primaryHrefs = new Set(primary.map((i) => i.href));
  const moreActive =
    needsMore && !primaryHrefs.has(pathname ?? "") &&
    fullNav.some((i) => !primaryHrefs.has(i.href) && isActive(pathname, i.href));

  return (
    <>
      <nav
        className="md:hidden print:hidden fixed bottom-0 inset-x-0 z-40 bg-bg/95 backdrop-blur border-t border-border"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <ul
          className="grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {primary.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <NavLink
                  href={item.href}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 h-16 text-[11px] transition-colors",
                    active ? "text-text-primary" : "text-text-muted",
                  )}
                >
                  <Icon size={20} />
                  <span className="max-w-full truncate px-0.5">
                    {item.shortLabel ?? item.label}
                  </span>
                  <span
                    className={cn(
                      "h-1 w-1 rounded-full transition-colors",
                      active ? "bg-gold" : "bg-transparent",
                    )}
                  />
                </NavLink>
              </li>
            );
          })}

          {needsMore && (
            <li>
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                aria-label="More pages"
                aria-expanded={sheetOpen}
                className={cn(
                  "w-full flex flex-col items-center justify-center gap-1 h-16 text-[11px] transition-colors",
                  moreActive ? "text-text-primary" : "text-text-muted",
                )}
              >
                <MoreIcon size={20} />
                <span>More</span>
                <span
                  className={cn(
                    "h-1 w-1 rounded-full transition-colors",
                    moreActive ? "bg-gold" : "bg-transparent",
                  )}
                />
              </button>
            </li>
          )}
        </ul>
      </nav>

      {needsMore && (
        <MoreSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={fullNav}
          pathname={pathname}
        />
      )}
    </>
  );
}

function MoreSheet({
  open,
  onClose,
  items,
  pathname,
}: {
  open: boolean;
  onClose: () => void;
  items: { href: string; label: string; icon: React.ComponentType<{ size?: number }>; group?: string }[];
  pathname: string | null;
}) {
  return (
    <div
      className={cn(
        "md:hidden fixed inset-0 z-50 transition-[visibility] duration-200",
        open ? "visible" : "invisible",
      )}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/50 transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0",
        )}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="All pages"
        className={cn(
          "absolute inset-x-0 bottom-0 bg-bg border-t border-border rounded-t-2xl shadow-2xl",
          "max-h-[75vh] flex flex-col transition-transform duration-200 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {/* Grab handle + header */}
        <div className="pt-2">
          <div className="mx-auto h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="flex items-center justify-between px-4 h-12">
          <span className="text-sm font-semibold">All pages</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-8 w-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <nav className="overflow-y-auto px-2 pb-3">
          {items.map((item, idx) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            const prev = items[idx - 1];
            const showGroupLabel = item.group && prev?.group !== item.group;
            return (
              <React.Fragment key={item.href}>
                {showGroupLabel && (
                  <p className="px-3 mt-3 mb-1 text-[10px] uppercase tracking-[0.18em] text-text-muted">
                    {item.group}
                  </p>
                )}
                <NavLink
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    "relative flex items-center gap-3 h-12 px-3 rounded-xl text-sm transition-colors",
                    active
                      ? "bg-surface text-text-primary"
                      : "text-text-muted hover:text-text-primary hover:bg-surface/60",
                  )}
                >
                  {active && (
                    <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-gold" />
                  )}
                  <Icon size={18} />
                  <span className="font-medium">{item.label}</span>
                </NavLink>
              </React.Fragment>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
