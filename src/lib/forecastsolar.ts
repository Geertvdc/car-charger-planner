import { floorToHour, parseNaiveLocal } from "./time";

const BASE = "https://api.forecast.solar/estimate";

export interface SolarConfig {
  lat: number;
  lon: number;
  tilt: number; // declination degrees
  azimuth: number; // -180..180, 0=south
  kwp: number;
}

/**
 * Fetch a PV production forecast for one simplified, whole-roof string, bucketed into
 * UTC hours (Wh). Forecast.Solar free tier: no key, rate-limited to 12 requests/hour per
 * IP — one string keeps a normal 30-min refresh well under that.
 */
export async function fetchForecastSolar(s: SolarConfig, tz: string): Promise<Map<number, number>> {
  const url = `${BASE}/${s.lat}/${s.lon}/${s.tilt}/${s.azimuth}/${s.kwp}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Forecast.Solar ${res.status}`);
  }
  const data = (await res.json()) as {
    result?: { watt_hours_period?: Record<string, number> };
  };
  const period = data.result?.watt_hours_period ?? {};
  const byHour = new Map<number, number>();
  for (const [ts, wh] of Object.entries(period)) {
    const hourStart = floorToHour(parseNaiveLocal(ts, tz));
    const key = hourStart.getTime();
    byHour.set(key, (byHour.get(key) ?? 0) + wh);
  }
  return byHour;
}
