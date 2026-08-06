import { prisma } from "./db";
import { resolveDay, statusForHour, WindowDef } from "./availability";
import { computeMultiPlan, Deadline, EngineHour } from "./engine";
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

// Plan across today + tomorrow + the following morning's deadline, so the whole
// visible timeline is scheduled (not just the immediate next deadline).
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

export async function recomputePlan(nowOverride?: Date) {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const car = await prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } });
  const latestSoc = await prisma.carState.findFirst({ orderBy: { at: "desc" } });
  const tz = settings.timezone;
  const now = resolveNow(settings.simulatedNow, nowOverride);
  const nowHour = floorToHour(now);

  const deadlines = await upcomingDeadlines(now, tz);
  if (deadlines.length === 0) {
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
          reason: "No upcoming deadline configured.",
        },
      }),
    ]);
    return;
  }

  // Build priced hours from now to the end of tomorrow (prices only cover today+tomorrow).
  // A deadline the morning after still draws on these hours as candidates.
  const today = todayISO(tz, now);
  const hoursEnd = localDayStartUTC(addDaysISO(today, 2), tz);
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

  return result;
}
