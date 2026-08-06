const BASE = "https://geocoding-api.open-meteo.com/v1/search";

export interface GeoResult {
  name: string; // "Uden, North Brabant, The Netherlands"
  latitude: number;
  longitude: number;
  timezone: string;
}

interface OmResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  admin1?: string;
  country?: string;
}

async function search(name: string): Promise<OmResult | null> {
  const params = new URLSearchParams({ name, count: "1", language: "en", format: "json" });
  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Geocoding ${res.status}`);
  const data = (await res.json()) as { results?: OmResult[] };
  return data.results?.[0] ?? null;
}

/**
 * Resolve a place name to coordinates + timezone via Open-Meteo (free, no key).
 * Open-Meteo matches on the settlement name only, so "Uden, Netherlands" won't match —
 * fall back to the part before the first comma, then the first word.
 */
export async function geocodePlace(query: string): Promise<GeoResult | null> {
  const candidates = Array.from(
    new Set([query.trim(), query.split(",")[0].trim(), query.trim().split(/\s+/)[0]])
  ).filter(Boolean);

  for (const c of candidates) {
    const r = await search(c);
    if (r) {
      const label = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
      return { name: label, latitude: r.latitude, longitude: r.longitude, timezone: r.timezone };
    }
  }
  return null;
}
