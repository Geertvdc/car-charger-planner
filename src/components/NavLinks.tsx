"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Weekly schedule" },
  { href: "/upcoming", label: "Upcoming days" },
  { href: "/config", label: "Car & solar" },
  { href: "/settings", label: "Settings" },
];

export default function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="pill-nav shrink-0">
      {nav.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={`pill-link ${active ? "active" : ""}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
