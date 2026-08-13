import { prisma } from "./db";
import { applyChargerConnectedOverride, AvailStatus, resolveDay, statusForHour, WindowDef } from "./availability";
import { resolveNow } from "./now";
import {
  addDaysISO,
  addMinutes,
  floorToHour,
  floorToSlot,
  localDateISO,
  localDayStartUTC,
  localHour,
  localMinute,
  localTimeToUTC,
  SLOT_MINUTES,
  todayISO,
} from "./time";

export interface TimelineHour {
  hourStart: string; // ISO UTC, 15-min slot start
  localHour: number;
  localMinute: number; // 0 | 15 | 30 | 45
  allInPrice: number | null;
  rawPrice: number | null;
  solarWh: number;
  availability: AvailStatus;
  // true when `availability` is HOME only because the charger's plugged in right now
  // (see applyChargerConnectedOverride) — the schedule itself says away.
  forcedHome: boolean;
  planned: boolean;
  plannedKwh: number;
  plannedSource: string | null;
  plannedReason: string | null; // target | cheap
  actual: boolean | null;
  isPast: boolean;
}

export interface TimelineDay {
  dateISO: string;
  label: string;
  isToday: boolean;
  isFuture: boolean;
  deadlineHour: string | null; // ISO UTC of the deadline
  deadlineTime: string;
  targetSoc: number;
  isOverride: boolean;
  hours: TimelineHour[];
}

export interface TimelineData {
  tz: string;
  days: TimelineDay[];
  now: string;
  simulated: boolean;
}

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Build the rolling timeline: history (historyDays) + today + tomorrow. */
export async function buildTimeline(nowOverride?: Date): Promise<TimelineData> {
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: 1 } });
  const tz = settings.timezone;
  const now = resolveNow(settings.simulatedNow, nowOverride);
  const today = todayISO(tz, now);

  const startISO = addDaysISO(today, -settings.historyDays);
  // exclusive end: covers today + the next two days. Prices/solar only exist for
  // today+tomorrow, but the extra day still renders so its target/availability can
  // be set ahead of time.
  const endISO = addDaysISO(today, 3);
  const rangeStart = localDayStartUTC(startISO, tz);
  const rangeEnd = localDayStartUTC(endISO, tz);

  const [prices, solar, slots, logs, planState] = await Promise.all([
    prisma.priceSnapshot.findMany({
      where: { hourStart: { gte: rangeStart, lt: rangeEnd } },
    }),
    prisma.solarForecast.findMany({
      where: { hourStart: { gte: rangeStart, lt: rangeEnd } },
    }),
    prisma.chargeSlot.findMany({
      where: { hourStart: { gte: rangeStart, lt: rangeEnd } },
    }),
    prisma.chargeLog.findMany({
      where: { at: { gte: rangeStart, lt: rangeEnd } },
      orderBy: { at: "asc" },
    }),
    prisma.planState.findUnique({ where: { id: 1 } }),
  ]);

  const priceMap = new Map(prices.map((p) => [p.hourStart.getTime(), p]));
  const solarMap = new Map(solar.map((s) => [s.hourStart.getTime(), s.expectedWh]));
  const slotMap = new Map(slots.map((s) => [s.hourStart.getTime(), s]));

  // Actual charge state as a step function from the logs.
  const actualAt = (t: Date): boolean | null => {
    let state: boolean | null = null;
    for (const l of logs) {
      if (l.at.getTime() <= t.getTime()) state = l.on;
      else break;
    }
    return state;
  };

  // Resolve each date's availability config once.
  const dateList: string[] = [];
  for (let d = startISO; d !== endISO; d = addDaysISO(d, 1)) dateList.push(d);
  const dayConfigs = new Map<string, { windows: WindowDef[]; deadlineTime: string; targetSoc: number; isOverride: boolean }>();
  await Promise.all(
    dateList.map(async (d) => {
      const cfg = await resolveDay(d);
      dayConfigs.set(d, cfg);
    })
  );

  const days: TimelineDay[] = dateList.map((dateISO) => {
    const cfg = dayConfigs.get(dateISO)!;
    const dow = (new Date(dateISO + "T12:00:00").getDay() + 6) % 7; // 0=Mon
    const deadlineHour = localTimeToUTC(dateISO, cfg.deadlineTime, tz);
    return {
      dateISO,
      label: `${WEEKDAY[dow]} ${dateISO.slice(5)}`,
      isToday: dateISO === today,
      isFuture: dateISO > today,
      deadlineHour: deadlineHour.toISOString(),
      deadlineTime: cfg.deadlineTime,
      targetSoc: cfg.targetSoc,
      isOverride: cfg.isOverride,
      hours: [],
    };
  });
  const dayByISO = new Map(days.map((d) => [d.dateISO, d]));

  // Build the flat, chronological slot list first (mutable availability) so the
  // charger-connected override — which needs to see the whole away run ahead of each
  // slot — can be applied in one pass before anything is pushed into its day.
  interface DraftHour extends Omit<TimelineHour, "hourStart" | "forcedHome"> {
    hourStart: Date;
    day: TimelineDay;
  }
  const draft: DraftHour[] = [];
  for (let t = new Date(rangeStart); t < rangeEnd; t = addMinutes(t, SLOT_MINUTES)) {
    const dateISO = localDateISO(t, tz);
    const day = dayByISO.get(dateISO);
    if (!day) continue;
    const cfg = dayConfigs.get(dateISO)!;
    const key = t.getTime();
    const price = priceMap.get(key);
    const slot = slotMap.get(key);
    const isPast = t.getTime() < now.getTime();
    // Solar forecast is hourly only; split its hour's energy evenly across the four
    // 15-min slots it covers (mirrors the same split in plan.ts's engine input).
    const hourlySolarWh = solarMap.get(floorToHour(t).getTime()) ?? 0;
    draft.push({
      hourStart: new Date(t),
      day,
      localHour: localHour(t, tz),
      localMinute: localMinute(t, tz),
      allInPrice: price?.allInPrice ?? null,
      rawPrice: price?.rawPrice ?? null,
      solarWh: hourlySolarWh / 4,
      availability: statusForHour(t, dateISO, cfg.windows, tz),
      planned: slot?.on ?? false,
      plannedKwh: slot?.expectedKwh ?? 0,
      plannedSource: slot?.source ?? null,
      plannedReason: slot?.reason ?? null,
      actual: isPast ? actualAt(t) : null,
      isPast,
    });
  }

  const forced = planState?.chargerConnected
    ? applyChargerConnectedOverride(draft, floorToSlot(now))
    : new Set<number>();

  for (const { day, ...rest } of draft) {
    day.hours.push({ ...rest, hourStart: rest.hourStart.toISOString(), forcedHome: forced.has(rest.hourStart.getTime()) });
  }

  return { tz, days, now: now.toISOString(), simulated: settings.simulatedNow != null };
}
