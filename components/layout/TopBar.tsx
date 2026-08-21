"use client";

import { Logo } from "./Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { StoreSwitcher, type StoreOption } from "./StoreSwitcher";

export function MobileTopBar({
  userName,
  stores,
  activeStoreId = null,
  homeStoreId = null,
}: {
  userName?: string | null;
  /** Manager multi-store switcher — omit to hide it. */
  stores?: StoreOption[];
  activeStoreId?: string | null;
  homeStoreId?: string | null;
}) {
  const showSwitcher = stores != null && stores.length > 1;
  return (
    <header className="md:hidden print:hidden sticky top-0 z-30 bg-bg/95 backdrop-blur border-b border-border h-14 flex items-center justify-between px-4">
      <Logo />
      <div className="flex items-center gap-2 min-w-0">
        {showSwitcher ? (
          <StoreSwitcher
            stores={stores!}
            activeStoreId={activeStoreId}
            homeStoreId={homeStoreId}
            compact
          />
        ) : (
          userName && (
            <span className="text-xs text-text-muted truncate max-w-[140px] text-right">
              {userName}
            </span>
          )
        )}
        <ThemeToggle variant="icon" className="h-9 w-9" />
      </div>
    </header>
  );
}
