import { prisma } from "./db";
import { fetchEnergyZeroDay } from "./energyzero";
import { fetchForecastSolarString } from "./forecastsolar";
import { getEntityState } from "./ha-client";
import { allInPrice } from "./pricing";
import { addDaysISO, localDayBoundsUTC, todayISO } from "./time";

export interface RefreshResult {
  prices: { ok: boolean; count: number; error?: string };
  solar: { ok: boolean; count: number; error?: string };
  power: { ok: boolean; count: number; error?: string };
  carSoc: { ok: boolean; count: number; error?: string };
  chargerConnected: { ok: boolean; count: number; error?: string };
}

/**
 * Past days EnergyZero returned no prices at all for. Those gaps are permanent — a day
 * with no published prices will never gain any — so retrying them on every 30-minute
 * tick would just be pointless traffic to a free public API. Deliberately in-memory:
 * it clears on restart, which is exactly when another look is worth taking.
 */
const emptyHistoricalDays = new Set<string>();

/** Test seam — the backfill skip-list is process-lifetime state. */
export function __resetPriceBackfillCache(): void {
  emptyHistoricalDays.clear();
}

/** Have we already stored every hour of this local day? (DST-aware: 23/24/25 hours.) */
async function isPriceDayComplete(dateISO: string, tz: string): Promise<boolean> {
  const { start, end } = localDayBoundsUTC(dateISO, tz);
  const expected = Math.round((end.getTime() - start.getTime()) / 3_600_000);
  const stored = await prisma.priceSnapshot.count({
    where: { hourStart: { gte: start, lt: end } },
  });
  return stored >= expected;
}

/**
 * Which local days to fetch. Today and tomorrow always, because tomorrow's day-ahead
 * prices publish in the early afternoon and today's can still be corrected. Past days
 * within the timeline's history window only when they're actually incomplete — a day
 * the app wasn't running for leaves a hole that EnergyZero can still fill, but a day
 * already stored in full must not be refetched every tick.
 */
async function pricesDatesToFetch(today: string, tz: string, historyDays: number) {
  const dates = [today, addDaysISO(today, 1)];
  for (let i = 1; i <= historyDays; i++) {
    const dateISO = addDaysISO(today, -i);
    if (emptyHistoricalDays.has(dateISO)) continue;
    if (await isPriceDayComplete(dateISO, tz)) continue;
    dates.push(dateISO);
  }
  return dates;
}

export async function refreshPrices(): Promise<RefreshResult["prices"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const tz = settings.timezone;
  const today = todayISO(tz);
  const dates = await pricesDatesToFetch(today, tz, settings.historyDays);

  let count = 0;
  const errors: string[] = [];
  // Per-day error handling: a backfill day that fails must not discard prices already
  // fetched for today/tomorrow, which are the ones the planner actually needs.
  for (const dateISO of dates) {
    try {
      const points = await fetchEnergyZeroDay(dateISO, tz);
      if (points.length === 0 && dateISO < today) {
        emptyHistoricalDays.add(dateISO);
        continue;
      }
      for (const p of points) {
        const allIn = allInPrice(p.rawPrice, settings);
        await prisma.priceSnapshot.upsert({
          where: { hourStart: p.hourStart },
          create: { hourStart: p.hourStart, rawPrice: p.rawPrice, allInPrice: allIn },
          update: { rawPrice: p.rawPrice, allInPrice: allIn, fetchedAt: new Date() },
        });
        count++;
      }
    } catch (e) {
      // Graceful: keep whatever snapshots we already have, and retry next tick.
      errors.push(`${dateISO}: ${(e as Error).message}`);
    }
  }

  if (errors.length === 0) return { ok: true, count };
  return { ok: false, count, error: errors.join("; ") };
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

/** Read the configured HomeWizard power sensor via HA and log one reading. Display only. */
export async function refreshPower(): Promise<RefreshResult["power"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const entityId = settings.haPowerSensorEntityId?.trim();
  if (!entityId) return { ok: true, count: 0 };
  try {
    const entity = await getEntityState(entityId);
    if (!entity) return { ok: true, count: 0 };
    const watts = parseFloat(entity.state);
    if (!Number.isFinite(watts)) {
      return { ok: false, count: 0, error: `non-numeric state from HA: ${entity.state}` };
    }
    await prisma.powerReading.create({ data: { watts } });
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

/**
 * Read the configured car SoC sensor via HA (e.g. the EU Data Act portal integration)
 * and record a new CarState row — but only when the entity's own last_changed has
 * advanced since the last ha_car reading, so a repeated stale poll never overwrites a
 * more recent manual entry (recomputePlan() already picks whichever CarState row is
 * newest by `at`, regardless of source).
 */
export async function refreshCarSoc(): Promise<RefreshResult["carSoc"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const entityId = settings.haCarSocEntityId?.trim();
  if (!entityId) return { ok: true, count: 0 };
  try {
    const entity = await getEntityState(entityId);
    if (!entity) return { ok: true, count: 0 };
    const soc = Math.round(parseFloat(entity.state));
    if (!Number.isFinite(soc) || soc < 0 || soc > 100) {
      return { ok: false, count: 0, error: `implausible SoC from HA: ${entity.state}` };
    }
    const rawUpdatedAt = new Date(entity.last_changed);
    if (isNaN(rawUpdatedAt.getTime())) {
      return { ok: false, count: 0, error: `invalid last_changed from HA: ${entity.last_changed}` };
    }
    const lastHa = await prisma.carState.findFirst({
      where: { source: "ha_car" },
      orderBy: { at: "desc" },
    });
    if (lastHa?.rawUpdatedAt && lastHa.rawUpdatedAt.getTime() >= rawUpdatedAt.getTime()) {
      return { ok: true, count: 0 };
    }
    await prisma.carState.create({ data: { soc, source: "ha_car", rawUpdatedAt } });
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

/**
 * Read the configured "cable connected" binary_sensor via HA and store the latest
 * known state on PlanState. recomputePlan() reads that stored value (not a live HA
 * call) to force the current hour "home" when a car is physically connected — see
 * plan.ts. Called from refreshAll() (30 min + manual refresh) and, more frequently,
 * from the scheduler's background recompute tick (src/lib/scheduler.ts) so the
 * override reacts within ~10 min without adding a live HA round-trip to every
 * interactive recomputePlan() call (settings saves, timeline edits, etc.).
 */
export async function refreshChargerConnected(): Promise<RefreshResult["chargerConnected"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const entityId = settings.haChargerConnectedEntityId?.trim();
  if (!entityId) return { ok: true, count: 0 };
  try {
    const entity = await getEntityState(entityId);
    if (!entity) return { ok: true, count: 0 };
    const connected = entity.state === "on";
    await prisma.planState.update({ where: { id: 1 }, data: { chargerConnected: connected } });
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function refreshAll(): Promise<RefreshResult> {
  const [prices, solar, power, carSoc, chargerConnected] = await Promise.all([
    refreshPrices(),
    refreshSolar(),
    refreshPower(),
    refreshCarSoc(),
    refreshChargerConnected(),
  ]);
  // Recompute the plan against the freshest data.
  const { recomputePlan } = await import("./plan");
  await recomputePlan().catch(() => undefined);
  return { prices, solar, power, carSoc, chargerConnected };
}
