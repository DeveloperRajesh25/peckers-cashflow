"use client";

import Link from "next/link";
import * as React from "react";

/**
 * A nav link that doesn't prefetch merely for being on screen.
 *
 * The sidebar and the bottom bar sit in the viewport permanently, so Next's
 * default viewport prefetch fires one RSC request per link — 13 of them for an
 * admin — and each runs the middleware and re-renders the layout. On a
 * force-dynamic route a prefetch can only ever return the loading skeleton (the
 * page's own queries run on click either way), so paying for every link up
 * front buys very little while competing with the page actually being loaded.
 *
 * The first hover/focus/touch hands `prefetch` back to Next's default, which
 * arms its normal viewport prefetch for that link — the same partial "auto"
 * request as before, now only for the one about to be clicked. Passing
 * `prefetch={true}` instead would ask for a FULL prefetch, which on a dynamic
 * route means rendering the whole page; the default is deliberate.
 */
export function NavLink({
  href,
  className,
  onClick,
  children,
}: {
  href: string;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const [armed, setArmed] = React.useState(false);
  const arm = React.useCallback(() => setArmed(true), []);

  return (
    <Link
      href={href}
      prefetch={armed ? undefined : false}
      onMouseEnter={arm}
      onFocus={arm}
      onTouchStart={arm}
      onClick={onClick}
      className={className}
    >
      {children}
    </Link>
  );
}
