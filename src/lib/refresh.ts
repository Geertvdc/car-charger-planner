import { prisma } from "./db";
import { fetchEnergyZeroDay } from "./energyzero";
import { fetchForecastSolarString } from "./forecastsolar";
import { getEntityState } from "./ha-client";
import { allInPrice, feedInPrice } from "./pricing";
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

/** Have we already stored every 15-min slot of this local day? (DST-aware: 92/96/100.) */
async function isPriceDayComplete(dateISO: string, tz: string): Promise<boolean> {
  const { start, end } = localDayBoundsUTC(dateISO, tz);
  const expected = Math.round((end.getTime() - start.getTime()) / 900_000);
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
        const feedIn = feedInPrice(p.rawPrice, settings);
        await prisma.priceSnapshot.upsert({
          where: { hourStart: p.hourStart },
          create: {
            hourStart: p.hourStart,
            rawPrice: p.rawPrice,
            allInPrice: allIn,
            feedInPrice: feedIn,
          },
          update: {
            rawPrice: p.rawPrice,
            allInPrice: allIn,
            feedInPrice: feedIn,
            fetchedAt: new Date(),
          },
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

/** Samples older than this are of no use to the controller's median window. */
const POWER_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** Read one entity's state as a number; null when unset, missing or unreadable. */
async function readWatts(entityId: string | undefined): Promise<number | null> {
  const id = entityId?.trim();
  if (!id) return null;
  const entity = await getEntityState(id);
  if (!entity) return null;
  const value = parseFloat(entity.state);
  return Number.isFinite(value) ? value : null;
}

/**
 * Take one aligned power sample: grid, charger and PV together.
 *
 * All three are fetched in parallel and stored on a single row on purpose. The surplus
 * controller subtracts the charger from the grid figure to find the household's true
 * surplus, and doing that across readings taken seconds apart — while the car's draw is
 * ramping — produces phantom surplus and a charger that hunts.
 *
 * Called every 30 s by the scheduler, so old rows are pruned as we go.
 */
export async function refreshPowerSample(): Promise<RefreshResult["power"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const entityId = settings.haPowerSensorEntityId?.trim();
  if (!entityId) return { ok: true, count: 0 };
  try {
    const [gridEntity, chargerWatts, pvWatts] = await Promise.all([
      getEntityState(entityId),
      readWatts(settings.haChargerPowerEntityId),
      readWatts(settings.haSolarPowerEntityId),
    ]);
    // A missing entity is benign (nothing to record yet); a present entity reporting
    // something non-numeric is a real misconfiguration worth surfacing.
    if (!gridEntity) return { ok: true, count: 0 };
    const watts = parseFloat(gridEntity.state);
    if (!Number.isFinite(watts)) {
      return { ok: false, count: 0, error: `non-numeric state from HA: ${gridEntity.state}` };
    }
    await prisma.powerReading.create({ data: { watts, chargerWatts, pvWatts } });
    await prisma.powerReading.deleteMany({
      where: { at: { lt: new Date(Date.now() - POWER_RETENTION_MS) } },
    });
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

/** States meaning a cable is plugged in, beyond a plain binary_sensor "on". */
const CONNECTED_STATES = new Set([
  "on",
  "true",
  "connected",
  "charging",
  // Zaptec's charger_mode enum: options are unknown | disconnected |
  // connected_requesting | connected_charging | connected_finished.
  "connected_requesting",
  "connected_charging",
  "connected_finished",
]);

const DISCONNECTED_STATES = new Set(["off", "false", "disconnected", "not_connected"]);

/**
 * States meaning an active charging session, a strict subset of CONNECTED_STATES.
 * "connected_requesting"/"connected_finished" mean plugged in but not drawing power —
 * only these mean current is actually flowing right now.
 */
const ACTIVELY_CHARGING_STATES = new Set(["charging", "connected_charging"]);

/**
 * Interpret a charger entity's state as "is a car plugged in".
 *
 * Returns null when the entity can't answer — `unknown`/`unavailable`, or a value we
 * don't recognise. Callers treat null as "no reading" and leave the stored value
 * alone, so a momentary HA blip can't drop the override and cancel a live session.
 *
 * Accepting more than "on"/"off" is what lets a charger-mode *sensor* be used here.
 * A plain binary_sensor is often the wrong entity: on the Zaptec integration the
 * obvious-looking `binary_sensor.<charger>_charger` is device_class `connectivity`
 * (the charger is online), which reads "on" permanently and would force every hour
 * to count as home.
 */
export function interpretConnectedState(state: string | undefined | null): boolean | null {
  const value = (state ?? "").trim().toLowerCase();
  if (CONNECTED_STATES.has(value)) return true;
  if (DISCONNECTED_STATES.has(value)) return false;
  return null;
}

/**
 * Interpret a charger entity's state as "is current actually flowing right now" —
 * finer-grained than interpretConnectedState(), only meaningful for a charger-mode
 * sensor (a plain binary_sensor can't distinguish "connected" from "charging").
 * Returns false (not null) for any state that isn't a recognised charging state,
 * including "unreadable" — display-only, so there's no override-cancelling risk in
 * defaulting to "not actively charging" the way interpretConnectedState defaults to
 * null/keep-last for the away-schedule override.
 */
export function interpretActivelyCharging(state: string | undefined | null): boolean {
  const value = (state ?? "").trim().toLowerCase();
  return ACTIVELY_CHARGING_STATES.has(value);
}

/**
 * Read the configured charger-connected entity via HA and store the latest known
 * state on PlanState. recomputePlan() reads that stored value (not a live HA call)
 * to treat away hours as home while a car is physically connected — see plan.ts.
 * Called from refreshAll() (30 min + manual refresh) and, more frequently, from the
 * scheduler's background recompute tick (src/lib/scheduler.ts) so the override reacts
 * within ~1 min without adding a live HA round-trip to every interactive
 * recomputePlan() call (settings saves, timeline edits, etc.).
 */
export async function refreshChargerConnected(): Promise<RefreshResult["chargerConnected"]> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const entityId = settings.haChargerConnectedEntityId?.trim();
  if (!entityId) return { ok: true, count: 0 };
  try {
    const entity = await getEntityState(entityId);
    if (!entity) return { ok: true, count: 0 };
    const connected = interpretConnectedState(entity.state);
    if (connected === null) return { ok: true, count: 0 }; // unreadable — keep the last value
    await prisma.planState.update({
      where: { id: 1 },
      data: { chargerConnected: connected, chargerReportedCharging: interpretActivelyCharging(entity.state) },
    });
    return { ok: true, count: 1 };
  } catch (e) {
    return { ok: false, count: 0, error: (e as Error).message };
  }
}

export async function refreshAll(): Promise<RefreshResult> {
  const [prices, solar, power, carSoc, chargerConnected] = await Promise.all([
    refreshPrices(),
    refreshSolar(),
    refreshPowerSample(),
    refreshCarSoc(),
    refreshChargerConnected(),
  ]);
  // Recompute the plan against the freshest data.
  const { recomputePlan } = await import("./plan");
  await recomputePlan().catch(() => undefined);
  return { prices, solar, power, carSoc, chargerConnected };
}
