import { DateTime } from "luxon";
import { prisma } from "./db";
import { localTimeToUTC } from "./time";

export type AvailStatus = "DEFINITE" | "MAYBE" | "AWAY";

export interface WindowDef {
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  status: "DEFINITE" | "MAYBE";
}

export interface DayConfig {
  dateISO: string;
  windows: WindowDef[];
  deadlineTime: string;
  targetSoc: number;
  isOverride: boolean;
}

/**
 * Effective availability + morning target for a local date.
 * A DayOverride (if present) replaces the weekly template's windows entirely;
 * its deadline/target fall back to the template when left null.
 */
export async function resolveDay(dateISO: string): Promise<DayConfig> {
  const dow = DateTime.fromISO(dateISO).weekday - 1; // 0=Mon..6=Sun
  const weekly = await prisma.weeklyDay.findUnique({
    where: { dayOfWeek: dow },
    include: { windows: true },
  });
  const override = await prisma.dayOverride.findUnique({
    where: { date: dateISO },
    include: { windows: true },
  });

  const deadlineTime = override?.deadlineTime ?? weekly?.deadlineTime ?? "07:00";
  const targetSoc = override?.targetSoc ?? weekly?.targetSoc ?? 80;

  // Window resolution:
  //  - override marked "away" => no windows at all
  //  - override with its own windows => those replace the template
  //  - override that only tweaks target/deadline => keep the template windows
  let source: { startTime: string; endTime: string; status: string }[];
  if (override?.away) source = [];
  else if (override && override.windows.length > 0) source = override.windows;
  else source = weekly?.windows ?? [];

  const windows: WindowDef[] = source.map((w) => ({
    startTime: w.startTime,
    endTime: w.endTime,
    status: w.status === "MAYBE" ? "MAYBE" : "DEFINITE",
  }));

  return { dateISO, windows, deadlineTime, targetSoc, isOverride: !!override };
}

/** Status for an hour bucket, given a day's windows. Priority DEFINITE > MAYBE > AWAY. */
export function statusForHour(
  hourStart: Date,
  dateISO: string,
  windows: WindowDef[],
  tz: string
): AvailStatus {
  let best: AvailStatus = "AWAY";
  for (const w of windows) {
    const start = localTimeToUTC(dateISO, w.startTime, tz);
    // "23:59" means through end-of-day; treat inclusive to the next hour boundary.
    const end = localTimeToUTC(dateISO, w.endTime, tz);
    if (hourStart >= start && hourStart < end) {
      if (w.status === "DEFINITE") return "DEFINITE";
      best = "MAYBE";
    }
  }
  return best;
}
