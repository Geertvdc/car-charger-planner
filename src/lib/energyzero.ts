import { floorToHour, localDayBoundsUTC } from "./time";

const BASE = "https://api.energyzero.nl/v1/energyprices";

export interface RawPricePoint {
  hourStart: Date; // UTC hour
  rawPrice: number; // EUR/kWh, excl. VAT/tax (raw market)
}

/**
 * Fetch raw hourly market prices from EnergyZero for one local calendar day.
 * usageType=1 electricity, interval=4 hourly, inclBtw=false = raw market price.
 */
export async function fetchEnergyZeroDay(dateISO: string, tz: string): Promise<RawPricePoint[]> {
  const { start, end } = localDayBoundsUTC(dateISO, tz);
  const params = new URLSearchParams({
    fromDate: start.toISOString(),
    tillDate: new Date(end.getTime() - 1).toISOString(),
    interval: "4",
    usageType: "1",
    inclBtw: "false",
  });
  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    // Prices are stable once published; short cache is fine.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`EnergyZero ${res.status} for ${dateISO}`);
  }
  const data = (await res.json()) as { Prices?: { readingDate: string; price: number }[] };
  if (!data.Prices || data.Prices.length === 0) return [];
  return data.Prices.map((p) => ({
    hourStart: floorToHour(new Date(p.readingDate)),
    rawPrice: p.price,
  }));
}
