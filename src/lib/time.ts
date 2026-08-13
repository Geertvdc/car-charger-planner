import { DateTime } from "luxon";

/**
 * All persisted timestamps are UTC instants aligned to whole hours ("hour grid").
 * All human-facing reasoning (day boundaries, "07:00" deadlines, availability
 * windows) happens in the configured IANA timezone via these helpers.
 */

export function floorToHour(d: Date): Date {
  const t = new Date(d);
  t.setUTCMinutes(0, 0, 0);
  return t;
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600_000);
}

/** Pricing/engine grid: EnergyZero's day-ahead market publishes quarter-hour prices. */
export const SLOT_MINUTES = 15;

export function floorToSlot(d: Date): Date {
  const t = new Date(d);
  const m = t.getUTCMinutes();
  t.setUTCMinutes(m - (m % SLOT_MINUTES), 0, 0);
  return t;
}

export function addMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000);
}

/** Local calendar date (YYYY-MM-DD) for a UTC instant, in the given tz. */
export function localDateISO(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-MM-dd");
}

/** Hour-of-day (0..23) in local tz for a UTC instant. */
export function localHour(d: Date, tz: string): number {
  return DateTime.fromJSDate(d, { zone: tz }).hour;
}

/** Minute-of-hour (0..59) in local tz for a UTC instant. */
export function localMinute(d: Date, tz: string): number {
  return DateTime.fromJSDate(d, { zone: tz }).minute;
}

/** Day-of-week with 0=Monday..6=Sunday, in local tz. */
export function localDow(d: Date, tz: string): number {
  return DateTime.fromJSDate(d, { zone: tz }).weekday - 1; // luxon: 1=Mon..7=Sun
}

/** Today's local date (YYYY-MM-DD). */
export function todayISO(tz: string, now = new Date()): string {
  return localDateISO(now, tz);
}

/** Shift a local YYYY-MM-DD by n days. */
export function addDaysISO(dateISO: string, n: number): string {
  return DateTime.fromISO(dateISO).plus({ days: n }).toFormat("yyyy-MM-dd");
}

/** UTC instant for local midnight of a given local date. */
export function localDayStartUTC(dateISO: string, tz: string): Date {
  return DateTime.fromISO(dateISO, { zone: tz }).startOf("day").toUTC().toJSDate();
}

/** {start,end} UTC instants spanning a local calendar day. */
export function localDayBoundsUTC(dateISO: string, tz: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(dateISO, { zone: tz }).startOf("day");
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}

/** Combine a local date + "HH:MM" into a UTC instant. */
export function localTimeToUTC(dateISO: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return DateTime.fromISO(dateISO, { zone: tz })
    .set({ hour: h, minute: m, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

/** Parse a naive "YYYY-MM-DD HH:MM:SS" string as local wall-clock in tz -> UTC instant. */
export function parseNaiveLocal(s: string, tz: string): Date {
  return DateTime.fromFormat(s, "yyyy-MM-dd HH:mm:ss", { zone: tz }).toUTC().toJSDate();
}

/** Human label like "Tue 14:00" in local tz. */
export function shortLabel(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("ccc HH:mm");
}
