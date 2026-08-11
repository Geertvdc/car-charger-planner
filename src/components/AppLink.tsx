"use client";

import Link from "next/link";
import { useBasePath } from "./BasePathProvider";

/**
 * Internal navigation that also works under Home Assistant Ingress.
 *
 * Served directly, this is a plain `next/link` with client-side transitions. Behind
 * Ingress it degrades to a full-page anchor carrying the prefix: the app-router client
 * would otherwise navigate to the *prefixed* pathname while the server — which never
 * sees the prefix — answers for the unprefixed one, leaving `usePathname()` and route
 * matching disagreeing. Full loads are cheap here (five server-rendered pages) and
 * sidestep that mismatch entirely.
 */
export default function AppLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const basePath = useBasePath();
  if (basePath) {
    return (
      <a href={`${basePath}${href}`} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}
