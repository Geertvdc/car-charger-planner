import type { RawPricePoint } from "./energyzero";
import { floorToSlot } from "./time";

const BASE = "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices";

interface NordpoolEntry {
  deliveryStart: string;
  entryPerArea: Record<string, number>;
}

/**
 * Fetch real quarter-hour day-ahead prices from Nordpool's public data portal for one
 * NL calendar day. No API key needed. Nordpool resolves `date` against the bidding
 * area's own local day, which already lines up with the app's Europe/Amsterdam-only
 * assumption, so the plain YYYY-MM-DD is enough — no tz conversion needed here.
 *
 * Unlike EnergyZero (see energyzero.ts), Nordpool's day-ahead auction genuinely settles
 * at 15-minute resolution for NL: every slot gets its own real price instead of an
 * hour's price repeated four times.
 */
export async function fetchNordpoolDay(dateISO: string): Promise<RawPricePoint[]> {
  const params = new URLSearchParams({
    date: dateISO,
    market: "DayAhead",
    deliveryArea: "NL",
    currency: "EUR",
  });
  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  // 204 = auction not published yet for this day (or nothing on record for it).
  if (res.status === 204) return [];
  if (!res.ok) {
    throw new Error(`Nordpool ${res.status} for ${dateISO}`);
  }
  const data = (await res.json()) as { multiAreaEntries?: NordpoolEntry[] };
  const entries = data.multiAreaEntries ?? [];
  return entries
    .filter((e) => e.entryPerArea?.NL != null)
    .map((e) => ({
      hourStart: floorToSlot(new Date(e.deliveryStart)),
      // EUR/MWh -> EUR/kWh, matching EnergyZero's raw ex-VAT convention.
      rawPrice: e.entryPerArea.NL / 1000,
    }));
}
