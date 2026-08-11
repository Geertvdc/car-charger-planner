import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} }));

import { applyChargerConnectedOverride } from "./plan";
import type { EngineHour } from "./engine";
import type { AvailStatus } from "./availability";

const H = (iso: string) => new Date(iso);

/** Build hours from a compact availability string: H = home, A = away, one char/hour. */
function hoursFrom(startISO: string, pattern: string): EngineHour[] {
  return [...pattern].map((c, i) => ({
    hourStart: new Date(new Date(startISO).getTime() + i * 3600_000),
    allInPrice: 0.2,
    solarWh: 0,
    availability: (c === "H" ? "HOME" : "AWAY") as AvailStatus,
  }));
}

const shape = (hours: EngineHour[]) =>
  hours.map((h) => (h.availability === "HOME" ? "H" : "A")).join("");

describe("applyChargerConnectedOverride", () => {
  it("opens the whole away run the car is sitting in, not just the current hour", () => {
    // Away from now until the schedule says home again at the 6th hour.
    const hours = hoursFrom("2026-08-11T12:00:00Z", "AAAAAHHH");
    applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"));
    expect(shape(hours)).toBe("HHHHHHHH");
  });

  it("stops at the point the schedule already says home", () => {
    // A later away block (a trip) must stay away — the car being plugged in now says
    // nothing about next week.
    const hours = hoursFrom("2026-08-11T12:00:00Z", "AAHHHAAA");
    applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"));
    expect(shape(hours)).toBe("HHHHHAAA");
  });

  it("does nothing when the schedule already says home right now", () => {
    const hours = hoursFrom("2026-08-11T12:00:00Z", "HHHAAA");
    applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"));
    expect(shape(hours)).toBe("HHHAAA");
  });

  it("never rewrites hours before now", () => {
    const hours = hoursFrom("2026-08-11T10:00:00Z", "AAAAAA");
    applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"));
    expect(shape(hours)).toBe("AAHHHH");
  });

  it("opens every remaining hour when the whole horizon is away", () => {
    const hours = hoursFrom("2026-08-11T12:00:00Z", "AAAA");
    applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"));
    expect(shape(hours)).toBe("HHHH");
  });

  it("is a no-op on an empty horizon", () => {
    const hours: EngineHour[] = [];
    expect(() => applyChargerConnectedOverride(hours, H("2026-08-11T12:00:00Z"))).not.toThrow();
  });
});
