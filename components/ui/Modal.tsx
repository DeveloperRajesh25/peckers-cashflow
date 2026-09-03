"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
};

export function Modal({ open, onClose, title, description, children, footer, size = "md" }: Props) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" }[size];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          "relative w-full bg-surface border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl",
          "animate-slide-up max-h-[92dvh] overflow-y-auto overscroll-contain",
          widths,
        )}
      >
        {(title || description) && (
          <div className="px-4 sm:px-5 pt-5 pb-3 border-b border-border">
            {title && (
              <h2 className="text-base sm:text-lg font-semibold tracking-wide text-text-primary break-words">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-sm text-text-muted mt-1 break-words">{description}</p>
            )}
          </div>
        )}
        <div className="p-4 sm:p-5">{children}</div>
        {footer && (
          <div
            className={cn(
              "px-4 sm:px-5 pb-5 pt-3 border-t border-border bg-surface",
              "sticky bottom-0 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end",
              // On a phone the actions are thumb targets, not a toolbar.
              "[&>button]:w-full sm:[&>button]:w-auto",
            )}
            style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
