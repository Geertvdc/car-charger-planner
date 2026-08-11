"use client";

import { usePathname } from "next/navigation";
import AppLink from "./AppLink";
import { useBasePath } from "./BasePathProvider";

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Weekly schedule" },
  { href: "/upcoming", label: "Upcoming days" },
  { href: "/config", label: "Car & solar" },
  { href: "/settings", label: "Settings" },
];

export default function NavLinks() {
  const basePath = useBasePath();
  // Under Ingress the browser's path carries the prefix but the app's routes don't —
  // strip it back off before matching, or every tab reads as inactive.
  const rawPath = usePathname();
  const pathname =
    basePath && rawPath.startsWith(basePath) ? rawPath.slice(basePath.length) || "/" : rawPath;

  return (
    <nav className="pill-nav shrink-0">
      {nav.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <AppLink key={n.href} href={n.href} className={`pill-link ${active ? "active" : ""}`}>
            {n.label}
          </AppLink>
        );
      })}
    </nav>
  );
}
