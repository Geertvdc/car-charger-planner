import { prisma } from "./db";
import { resolveDay, statusForHour, WindowDef } from "./availability";
import { computeMultiPlan, Deadline, EngineHour } from "./engine";
import { logDecisionTransition } from "./ha";
import { syncChargerState } from "./ha-control";
import { resolveNow } from "./now";
import {
  addDaysISO,
  addHours,
  floorToHour,
  localDateISO,
  localDayStartUTC,
  localTimeToUTC,
  todayISO,
} from "./time";

// Look far enough ahead to see the deadline after tomorrow (so it shows up once its
// prices land), but planning itself is further capped to the known-price horizon below.
const DEADLINE_LOOKAHEAD_DAYS = 3;

/** All deadline instants after `now` within the lookahead, with their targets. */
async function upcomingDeadlines(now: Date, tz: string) {
  const today = todayISO(tz, now);
  const out: { instant: Date; dateISO: string; targetSoc: number }[] = [];
  for (let i = 0; i < DEADLINE_LOOKAHEAD_DAYS; i++) {
    const dateISO = addDaysISO(today, i);
    const cfg = await resolveDay(dateISO);
    const instant = localTimeToUTC(dateISO, cfg.deadlineTime, tz);
    if (instant.getTime() > now.getTime()) {
      out.push({ instant, dateISO, targetSoc: cfg.targetSoc });
    }
  }
  return out.sort((a, b) => a.instant.getTime() - b.instant.getTime());
}

/**
 * A physically connected car means you're clearly home, whatever the schedule says.
 *
 * Opens up the entire away stretch the car is currently sitting in — from the current
 * hour until the schedule next says home — rather than only the current hour. Charging
 * needs a *run* of eligible hours to be planned across: handed one hour at a time the
 * engine can't compare an away evening's prices and pick the cheapest, nor see that a
 * deadline is reachable at all.
 *
 * Scoped to the current run, so a later away block (a trip next week) stays away. And
 * it's re-derived on every recompute, so unplugging hands control back to the schedule
 * within a scheduler tick.
 */
export function applyChargerConnectedOverride(hours: EngineHour[], nowHour: Date): void {
  for (const hour of hours) {
    if (hour.hourStart.getTime() < nowHour.getTime()) continue;
    if (hour.availability === "HOME") break; // schedule agrees from here on
    hour.availability = "HOME";
  }
}

export async function recomputePlan(nowOverride?: Date) {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const car = await prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } });
  const latestSoc = await prisma.carState.findFirst({ orderBy: { at: "desc" } });
  const priorPlan = await prisma.planState.findUnique({ where: { id: 1 } });
  const tz = settings.timezone;
  const now = resolveNow(settings.simulatedNow, nowOverride);
  const nowHour = floorToHour(now);

  // Prices are day-ahead: only today + tomorrow are ever known. Only plan deadlines
  // that fall within that window — a deadline further out (e.g. the morning after
  // tomorrow) can't be scheduled sensibly yet since we don't know its hours' prices,
  // so leave it out of the engine until the next daily refresh rolls this window
  // forward and it comes into range. It still shows on the timeline as a target.
  const today = todayISO(tz, now);
  const hoursEnd = localDayStartUTC(addDaysISO(today, 2), tz);
  const allDeadlines = await upcomingDeadlines(now, tz);
  const deadlines = allDeadlines.filter((d) => d.instant.getTime() <= hoursEnd.getTime());

  if (deadlines.length === 0) {
    const reason =
      allDeadlines.length > 0
        ? "Next deadline's day-ahead prices aren't published yet — plan resumes once available."
        : "No upcoming deadline configured.";
    await prisma.$transaction([
      prisma.chargeSlot.deleteMany({}),
      prisma.planState.update({
        where: { id: 1 },
        data: {
          computedAt: now,
          charging: false,
          chargingUntil: null,
          targetSoc: null,
          feasible: true,
          shortfallKwh: 0,
          reason,
        },
      }),
    ]);
    await syncChargerState(false).catch(() => undefined);
    await logDecisionTransition(false).catch(() => undefined);
    return;
  }

  // Build priced hours from now to the end of tomorrow (prices only cover today+tomorrow).
  const [prices, solar] = await Promise.all([
    prisma.priceSnapshot.findMany({ where: { hourStart: { gte: nowHour, lt: hoursEnd } } }),
    prisma.solarForecast.findMany({ where: { hourStart: { gte: nowHour, lt: hoursEnd } } }),
  ]);
  const priceMap = new Map(prices.map((p) => [p.hourStart.getTime(), p.allInPrice]));
  const solarMap = new Map(solar.map((s) => [s.hourStart.getTime(), s.expectedWh]));

  const dayCache = new Map<string, { windows: WindowDef[] }>();
  const getDay = async (dateISO: string) => {
    let c = dayCache.get(dateISO);
    if (!c) {
      const cfg = await resolveDay(dateISO);
      c = { windows: cfg.windows };
      dayCache.set(dateISO, c);
    }
    return c;
  };

  const hours: EngineHour[] = [];
  for (let t = new Date(nowHour); t < hoursEnd; t = addHours(t, 1)) {
    const price = priceMap.get(t.getTime());
    if (price == null) continue;
    const dateISO = localDateISO(t, tz);
    const day = await getDay(dateISO);
    hours.push({
      hourStart: new Date(t),
      allInPrice: price,
      solarWh: solarMap.get(t.getTime()) ?? 0,
      availability: statusForHour(t, dateISO, day.windows, tz),
    });
  }

  if (priorPlan?.chargerConnected) {
    applyChargerConnectedOverride(hours, nowHour);
  }

  const engineDeadlines: Deadline[] = deadlines.map((d) => ({
    instant: d.instant,
    targetSoc: d.targetSoc,
  }));

  const result = computeMultiPlan({
    now,
    hours,
    deadlines: engineDeadlines,
    currentSoc: latestSoc?.soc ?? 50,
    batteryKwh: car.batteryKwh,
    chargerPowerKw: car.chargerPowerKw,
    efficiency: car.efficiency,
    houseLoadFactor: settings.houseLoadFactor,
    feedInTariffPerKwh: settings.feedInTariffPerKwh,
    maxSoc: car.maxSoc,
    cheapPriceThresholdPerKwh: settings.cheapPriceThresholdPerKwh,
  });

  // chargingUntil = end of the contiguous on-run starting at now.
  let chargingUntil: Date | null = null;
  if (result.chargingNow) {
    const onSet = new Set(result.slots.filter((s) => s.on).map((s) => s.hourStart.getTime()));
    let end = addHours(nowHour, 1);
    while (onSet.has(end.getTime())) end = addHours(end, 1);
    chargingUntil = end;
  }

  await prisma.$transaction([
    // Replace the whole forward-looking plan (history is tracked via ChargeLog).
    prisma.chargeSlot.deleteMany({}),
    prisma.chargeSlot.createMany({
      data: result.slots
        .filter((s) => s.on)
        .map((s) => ({
          hourStart: s.hourStart,
          on: true,
          expectedKwh: s.kwh,
          expectedCost: s.cost,
          source: s.source,
          reason: s.reason,
        })),
    }),
    prisma.planState.update({
      where: { id: 1 },
      data: {
        computedAt: now,
        charging: result.chargingNow,
        chargingUntil,
        targetSoc: deadlines[0].targetSoc, // the soonest deadline's target
        feasible: result.feasible,
        shortfallKwh: result.shortfallKwh,
        reason: result.reason,
      },
    }),
  ]);

  await syncChargerState(result.chargingNow).catch(() => undefined);
  await logDecisionTransition(result.chargingNow).catch(() => undefined);

  return result;
}
