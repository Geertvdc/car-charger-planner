import { prisma } from "./db";
import { AvailStatus, resolveDay, statusForHour, WindowDef } from "./availability";
import { resolveNow } from "./now";
import {
  addDaysISO,
  addHours,
  localDateISO,
  localDayStartUTC,
  localHour,
  localTimeToUTC,
  todayISO,
} from "./time";

export interface TimelineHour {
  hourStart: string; // ISO UTC
  localHour: number;
  allInPrice: number | null;
  rawPrice: number | null;
  solarWh: number;
  availability: AvailStatus;
  planned: boolean;
  plannedKwh: number;
  plannedSource: string | null;
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
  const endISO = addDaysISO(today, 2); // exclusive: covers today + tomorrow
  const rangeStart = localDayStartUTC(startISO, tz);
  const rangeEnd = localDayStartUTC(endISO, tz);

  const [prices, solar, slots, logs] = await Promise.all([
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

  for (let t = new Date(rangeStart); t < rangeEnd; t = addHours(t, 1)) {
    const dateISO = localDateISO(t, tz);
    const day = dayByISO.get(dateISO);
    if (!day) continue;
    const cfg = dayConfigs.get(dateISO)!;
    const key = t.getTime();
    const price = priceMap.get(key);
    const slot = slotMap.get(key);
    const isPast = t.getTime() < now.getTime();
    day.hours.push({
      hourStart: t.toISOString(),
      localHour: localHour(t, tz),
      allInPrice: price?.allInPrice ?? null,
      rawPrice: price?.rawPrice ?? null,
      solarWh: solarMap.get(key) ?? 0,
      availability: statusForHour(t, dateISO, cfg.windows, tz),
      planned: slot?.on ?? false,
      plannedKwh: slot?.expectedKwh ?? 0,
      plannedSource: slot?.source ?? null,
      actual: isPast ? actualAt(t) : null,
      isPast,
    });
  }

  return { tz, days, now: now.toISOString(), simulated: settings.simulatedNow != null };
}
