import * as React from "react";
import Link from "next/link";
import { Logo } from "@/components/layout/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

type OtherPortalLink = { href: string; label: string };

export function AuthShell({
  badge,
  title,
  subtitle,
  children,
  otherPortals,
}: {
  badge: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  otherPortals?: OtherPortalLink[];
}) {
  return (
    <main className="min-h-screen w-full grid place-items-center px-4 py-10 relative overflow-hidden">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle variant="icon" />
      </div>
      <div className="pointer-events-none absolute inset-0 opacity-60">
        <div className="absolute -top-32 -left-32 h-[420px] w-[420px] rounded-full bg-gold/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-24 h-[380px] w-[380px] rounded-full bg-gold/5 blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex items-center justify-center">
          <Logo tagline="Management software" variant="auth" />
        </div>

        <div className="rounded-2xl bg-surface border border-border p-7 shadow-2xl shadow-black/40">
          <span className="inline-block text-[10px] font-medium uppercase tracking-[0.18em] text-gold bg-gold/10 border border-gold/30 rounded-full px-2.5 py-1">
            {badge}
          </span>
          <h1 className="text-xl font-semibold tracking-wide text-text-primary mt-4">
            {title}
          </h1>
          <p className="text-sm text-text-muted mt-1.5 mb-6">{subtitle}</p>

          {children}
        </div>

        {otherPortals && otherPortals.length > 0 && (
          <div className="mt-5 flex items-center justify-center gap-4 text-xs text-text-muted">
            {otherPortals.map((p) => (
              <Link key={p.href} href={p.href} className="hover:text-gold transition-colors">
                {p.label}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/peckers-logo.png"
            alt="Peckers — Seriously Good Chicken"
            className="h-9 w-auto opacity-80 invert dark:invert-0"
          />
        </div>
      </div>
    </main>
  );
}
