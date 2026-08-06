import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Car Charger Planner",
  description:
    "Plan EV charging on dynamic NL energy prices, solar forecast and your home availability.",
};

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/schedule", label: "Weekly schedule" },
  { href: "/upcoming", label: "Upcoming days" },
  { href: "/config", label: "Car & solar" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-[var(--color-border)] bg-[var(--color-panel)]">
            <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <span className="text-xl">⚡</span>
                <span>Car Charger Planner</span>
              </Link>
              <nav className="flex flex-wrap gap-1 text-sm">
                {nav.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="rounded-md px-3 py-1.5 text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
