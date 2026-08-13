import { floorToHour, floorToSlot, localDayBoundsUTC } from "./time";

const BASE = "https://api.energyzero.nl/v1/energyprices";

export interface RawPricePoint {
  hourStart: Date; // UTC 15-min slot start
  rawPrice: number; // EUR/kWh, excl. VAT/tax (raw market)
}

async function fetchEnergyZeroInterval(
  interval: "3" | "4",
  start: Date,
  end: Date,
  dateISO: string
): Promise<{ readingDate: string; price: number }[]> {
  const params = new URLSearchParams({
    fromDate: start.toISOString(),
    tillDate: new Date(end.getTime() - 1).toISOString(),
    interval,
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
  return data.Prices ?? [];
}

/**
 * Fetch raw quarter-hour market prices from EnergyZero for one local calendar day.
 * usageType=1 electricity, inclBtw=false = raw market price.
 *
 * interval=3 (quarter-hour) is a documented, API-accepted value, but as of this
 * writing EnergyZero's backend doesn't actually have quarter-hour data behind it —
 * it consistently echoes intervalType:3 but returns an empty Prices array, for every
 * date tested. Rather than fetch nothing, fall back to interval=4 (hourly, which does
 * work) and replicate each hour's price across its four 15-min slots. The moment
 * EnergyZero populates real quarter-hour data, the primary request starts returning it
 * and this fallback stops triggering — no further code change needed.
 */
export async function fetchEnergyZeroDay(dateISO: string, tz: string): Promise<RawPricePoint[]> {
  const { start, end } = localDayBoundsUTC(dateISO, tz);

  const quarterPrices = await fetchEnergyZeroInterval("3", start, end, dateISO);
  if (quarterPrices.length > 0) {
    return quarterPrices.map((p) => ({
      hourStart: floorToSlot(new Date(p.readingDate)),
      rawPrice: p.price,
    }));
  }

  const hourlyPrices = await fetchEnergyZeroInterval("4", start, end, dateISO);
  const out: RawPricePoint[] = [];
  for (const p of hourlyPrices) {
    const hour = floorToHour(new Date(p.readingDate));
    for (let k = 0; k < 4; k++) {
      out.push({ hourStart: new Date(hour.getTime() + k * 900_000), rawPrice: p.price });
    }
  }
  return out;
}
