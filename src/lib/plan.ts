import { prisma } from "./db";
import { applyChargerConnectedOverride, resolveDay, statusForHour, WindowDef } from "./availability";
import { runChargeController } from "./controller";
import { computeMultiPlan, Deadline, EngineHour } from "./engine";
import { resolveNow } from "./now";
import {
  addDaysISO,
  addMinutes,
  floorToHour,
  floorToSlot,
  localDateISO,
  localDayStartUTC,
  localTimeToUTC,
  SLOT_MINUTES,
  todayISO,
} from "./time";

const SLOT_HOURS = SLOT_MINUTES / 60;

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

export async function recomputePlan(nowOverride?: Date) {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const car = await prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } });
  const latestSoc = await prisma.carState.findFirst({ orderBy: { at: "desc" } });
  const priorPlan = await prisma.planState.findUnique({ where: { id: 1 } });
  const tz = settings.timezone;
  const now = resolveNow(settings.simulatedNow, nowOverride);
  const nowHour = floorToSlot(now);

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
          chargingUntil: null,
          targetSoc: null,
          feasible: true,
          shortfallKwh: 0,
          reason,
          plannedOn: false,
          plannedAmps: null,
          plannedReason: null,
        },
      }),
    ]);
    // No deadline is not a reason to stop soaking up surplus — the controller decides.
    await runChargeController(nowOverride);
    return;
  }

  // Build priced hours from now to the end of tomorrow (prices only cover today+tomorrow).
  const [prices, solar] = await Promise.all([
    prisma.priceSnapshot.findMany({ where: { hourStart: { gte: nowHour, lt: hoursEnd } } }),
    prisma.solarForecast.findMany({ where: { hourStart: { gte: nowHour, lt: hoursEnd } } }),
  ]);
  const priceMap = new Map(prices.map((p) => [p.hourStart.getTime(), p]));
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
  for (let t = new Date(nowHour); t < hoursEnd; t = addMinutes(t, SLOT_MINUTES)) {
    const price = priceMap.get(t.getTime());
    if (price == null) continue;
    const dateISO = localDateISO(t, tz);
    const day = await getDay(dateISO);
    // Solar forecast is hourly only (see refreshSolar() in refresh.ts); split its hour's
    // energy evenly across the four 15-min slots it covers.
    const hourlySolarWh = solarMap.get(floorToHour(t).getTime()) ?? 0;
    hours.push({
      hourStart: new Date(t),
      allInPrice: price.allInPrice,
      feedInPrice: price.feedInPrice,
      solarWh: hourlySolarWh / 4,
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
    maxSoc: car.maxSoc,
    cheapPriceThresholdPerKwh: settings.cheapPriceThresholdPerKwh,
    slotHours: SLOT_HOURS,
    phases: car.phases,
    voltage: car.voltage,
    minCurrentA: car.minCurrentA,
    maxCurrentA: car.maxCurrentA,
  });

  // chargingUntil = end of the contiguous on-run starting at now.
  let chargingUntil: Date | null = null;
  if (result.chargingNow) {
    const onSet = new Set(result.slots.filter((s) => s.on).map((s) => s.hourStart.getTime()));
    let end = addMinutes(nowHour, SLOT_MINUTES);
    while (onSet.has(end.getTime())) end = addMinutes(end, SLOT_MINUTES);
    chargingUntil = end;
  }

  const currentSlot = result.slots.find((s) => s.on && s.hourStart.getTime() === nowHour.getTime());

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
          expectedAmps: s.amps,
        })),
    }),
    prisma.planState.update({
      where: { id: 1 },
      data: {
        computedAt: now,
        chargingUntil,
        targetSoc: deadlines[0].targetSoc, // the soonest deadline's target
        feasible: result.feasible,
        shortfallKwh: result.shortfallKwh,
        reason: result.reason,
        // Intent only. runChargeController() below reconciles this with the live grid
        // reading and is the only thing that touches the charger — see controller.ts.
        plannedOn: result.chargingNow,
        plannedAmps: currentSlot?.amps ?? null,
        plannedReason: currentSlot?.reason ?? null,
      },
    }),
  ]);

  await runChargeController(nowOverride);

  return result;
}
