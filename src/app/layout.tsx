import type { Metadata } from "next";
import Link from "next/link";
import { Manrope, JetBrains_Mono } from "next/font/google";
import NavLinks from "@/components/NavLinks";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Car Charger Planner",
  description:
    "Plan EV charging on dynamic NL energy prices, solar forecast and your home availability.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
      <body>
        <div className="bg-blobs">
          <div
            className="bg-blob"
            style={{
              top: "-360px",
              left: "-360px",
              width: "600px",
              height: "600px",
              background: "radial-gradient(circle, #FFC94D, transparent 68%)",
              opacity: 0.1,
              animation: "drift1 22s ease-in-out infinite",
            }}
          />
          <div
            className="bg-blob"
            style={{
              top: "30%",
              right: "-320px",
              width: "700px",
              height: "700px",
              background: "radial-gradient(circle, #4FB6FF, transparent 68%)",
              opacity: 0.09,
              animation: "drift2 26s ease-in-out infinite",
            }}
          />
          <div
            className="bg-blob"
            style={{
              top: "900px",
              left: "18%",
              width: "700px",
              height: "700px",
              background: "radial-gradient(circle, #FFD873, transparent 70%)",
              opacity: 0.08,
            }}
          />
        </div>

        <div className="relative z-[1] min-h-screen">
          <header className="sticky top-0 z-20 border-b border-white/10 bg-[rgba(6,8,13,0.72)] shadow-[0_1px_24px_rgba(0,0,0,0.3)] backdrop-blur-2xl backdrop-saturate-150">
            <div className="mx-auto flex max-w-6xl items-center gap-6 overflow-x-auto px-4 py-3">
              <Link
                href="/"
                className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[15px] font-extrabold tracking-tight"
              >
                <span className="text-lg drop-shadow-[0_0_8px_rgba(255,201,77,0.6)]">⚡</span>
                <span>Car Charger Planner</span>
              </Link>
              <NavLinks />
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
