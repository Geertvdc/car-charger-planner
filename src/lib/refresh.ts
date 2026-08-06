import { prisma } from "./db";
import { fetchEnergyZeroDay } from "./energyzero";
import { fetchForecastSolarString } from "./forecastsolar";
import { allInPrice } from "./pricing";
import { addDaysISO, todayISO } from "./time";

export interface RefreshResult {
  prices: { ok: boolean; count: number; error?: string };
  solar: { ok: boolean; count: number; error?: string };
}

export async function refreshPrices(): Promise<RefreshResult["prices"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const tz = settings.timezone;
  const dates = [todayISO(tz), addDaysISO(todayISO(tz), 1)];
  try {
    let count = 0;
    for (const dateISO of dates) {
      const points = await fetchEnergyZeroDay(dateISO, tz);
      for (const p of points) {
        const allIn = allInPrice(p.rawPrice, settings);
        await prisma.priceSnapshot.upsert({
          where: { hourStart: p.hourStart },
          create: { hourStart: p.hourStart, rawPrice: p.rawPrice, allInPrice: allIn },
          update: { rawPrice: p.rawPrice, allInPrice: allIn, fetchedAt: new Date() },
        });
        count++;
      }
    }
    return { ok: true, count };
  } catch (e) {
    // Graceful: keep whatever snapshots we already have.
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function refreshSolar(): Promise<RefreshResult["solar"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const strings = await prisma.pvString.findMany();
  const tz = settings.timezone;
  if (strings.length === 0) return { ok: true, count: 0 };
  try {
    const combined = new Map<number, number>();
    for (const s of strings) {
      const byHour = await fetchForecastSolarString(
        {
          lat: settings.latitude,
          lon: settings.longitude,
          tilt: s.tilt,
          azimuth: s.azimuth,
          kwp: s.kwp,
        },
        tz
      );
      for (const [key, wh] of byHour) {
        combined.set(key, (combined.get(key) ?? 0) + wh);
      }
    }
    let count = 0;
    for (const [key, wh] of combined) {
      const hourStart = new Date(key);
      await prisma.solarForecast.upsert({
        where: { hourStart },
        create: { hourStart, expectedWh: wh },
        update: { expectedWh: wh, fetchedAt: new Date() },
      });
      count++;
    }
    return { ok: true, count };
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function refreshAll(): Promise<RefreshResult> {
  const [prices, solar] = await Promise.all([refreshPrices(), refreshSolar()]);
  // Recompute the plan against the freshest data.
  const { recomputePlan } = await import("./plan");
  await recomputePlan().catch(() => undefined);
  return { prices, solar };
}
