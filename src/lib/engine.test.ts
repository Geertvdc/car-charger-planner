import { describe, expect, it } from "vitest";
import { computeMultiPlan, computePlan, EngineHour } from "./engine";
import type { AvailStatus } from "./availability";

const H = (iso: string) => new Date(iso);

function hour(
  iso: string,
  price: number,
  solarWh = 0,
  availability: AvailStatus = "DEFINITE"
): EngineHour {
  return { hourStart: H(iso), allInPrice: price, solarWh, availability };
}

const base = {
  now: H("2026-01-01T20:00:00Z"),
  currentSoc: 50,
  targetSoc: 80,
  batteryKwh: 60, // need (80-50)% * 60 = 18 kWh into battery
  chargerPowerKw: 10,
  efficiency: 1, // simplify: 10 kWh/h into battery
  houseLoadFactor: 0.7,
  feedInTariffPerKwh: 0,
};

describe("computePlan", () => {
  it("picks the cheapest home hours to meet the target", () => {
    // 20:00..06:00 window, one expensive hour at 22:00, cheapest overnight.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.4),
      hour("2026-01-01T21:00:00Z", 0.5),
      hour("2026-01-01T22:00:00Z", 0.9),
      hour("2026-01-01T23:00:00Z", 0.1),
      hour("2026-01-02T00:00:00Z", 0.05),
      hour("2026-01-02T01:00:00Z", 0.05),
    ];
    const r = computePlan({
      ...base,
      horizonEnd: H("2026-01-02T07:00:00Z"),
      hours,
    });
    expect(r.feasible).toBe(true);
    // Need 18 kWh at 10 kWh/h => the two cheapest 0.05 hours (20 kWh cap) suffice.
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).toContain("2026-01-02T00:00:00.000Z"); // 0.05
    expect(on).toContain("2026-01-02T01:00:00.000Z"); // 0.05
    expect(on).not.toContain("2026-01-01T22:00:00.000Z"); // 0.90 never chosen
    expect(on).not.toContain("2026-01-01T23:00:00.000Z"); // 0.10 not needed
    expect(r.scheduledKwh).toBeCloseTo(18, 5);
  });

  it("prefers solar-rich hours (lower effective cost)", () => {
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.3, 0),
      // Same grid price but solar covers the full charger power => effectively free.
      hour("2026-01-01T21:00:00Z", 0.3, 12000),
    ];
    const r = computePlan({
      ...base,
      houseLoadFactor: 1,
      targetSoc: 60, // need 6 kWh => under one hour
      horizonEnd: H("2026-01-01T22:00:00Z"),
      hours,
    });
    const on = r.slots.filter((s) => s.on);
    expect(on[0].hourStart.toISOString()).toBe("2026-01-01T21:00:00.000Z");
    expect(on[0].source).toBe("solar");
  });

  it("flags infeasible when home hours cannot meet the target", () => {
    // Only one 10 kWh hour available but 18 kWh needed.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.2, 0, "DEFINITE"),
      hour("2026-01-01T21:00:00Z", 0.2, 0, "AWAY"),
    ];
    const r = computePlan({
      ...base,
      horizonEnd: H("2026-01-01T22:00:00Z"),
      hours,
    });
    expect(r.feasible).toBe(false);
    expect(r.shortfallKwh).toBeCloseTo(8, 5);
  });

  it("only uses MAYBE hours to cover a shortfall, never over DEFINITE", () => {
    const hours: EngineHour[] = [
      // Cheap MAYBE vs pricier DEFINITE. Need 18 kWh; DEFINITE gives 20 kWh capacity.
      hour("2026-01-01T20:00:00Z", 0.05, 0, "MAYBE"),
      hour("2026-01-01T21:00:00Z", 0.5, 0, "DEFINITE"),
      hour("2026-01-01T22:00:00Z", 0.5, 0, "DEFINITE"),
    ];
    const r = computePlan({
      ...base,
      horizonEnd: H("2026-01-01T23:00:00Z"),
      hours,
    });
    const onStatuses = r.slots
      .filter((s) => s.on)
      .map((s) => hours.find((h) => h.hourStart.getTime() === s.hourStart.getTime())!.availability);
    // Both DEFINITE hours used; MAYBE ignored because DEFINITE alone suffices.
    expect(onStatuses.filter((s) => s === "DEFINITE").length).toBe(2);
    expect(onStatuses).not.toContain("MAYBE");
    expect(r.feasible).toBe(true);
  });

  it("uses a cheap window the day before ahead of an expensive night", () => {
    // Deadline tomorrow 07:00. A cheap home afternoon today vs an expensive home night.
    const hours: EngineHour[] = [
      hour("2026-01-01T14:00:00Z", 0.1, 0, "DEFINITE"), // cheap afternoon
      hour("2026-01-01T15:00:00Z", 0.1, 0, "DEFINITE"),
      hour("2026-01-02T02:00:00Z", 0.6, 0, "DEFINITE"), // expensive night
      hour("2026-01-02T03:00:00Z", 0.6, 0, "DEFINITE"),
    ];
    const r = computeMultiPlan({
      now: H("2026-01-01T13:00:00Z"),
      hours,
      deadlines: [{ instant: H("2026-01-02T07:00:00Z"), targetSoc: 80 }],
      currentSoc: 50,
      batteryKwh: 60,
      chargerPowerKw: 10,
      efficiency: 1,
      houseLoadFactor: 0.7,
      feedInTariffPerKwh: 0,
    });
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).toContain("2026-01-01T14:00:00.000Z"); // cheap afternoon used
    expect(on).toContain("2026-01-01T15:00:00.000Z");
    expect(on).not.toContain("2026-01-02T02:00:00.000Z"); // expensive night avoided
    expect(r.feasible).toBe(true);
  });

  it("satisfies two deadlines, banking cheap energy for later", () => {
    const hours: EngineHour[] = [
      hour("2026-01-01T14:00:00Z", 0.05, 0, "DEFINITE"), // very cheap
      hour("2026-01-01T22:00:00Z", 0.4, 0, "DEFINITE"),
      hour("2026-01-02T14:00:00Z", 0.05, 0, "DEFINITE"), // very cheap next day
    ];
    const r = computeMultiPlan({
      now: H("2026-01-01T13:00:00Z"),
      hours,
      deadlines: [
        { instant: H("2026-01-01T20:00:00Z"), targetSoc: 60 }, // need 6 kWh
        { instant: H("2026-01-02T20:00:00Z"), targetSoc: 70 }, // +6 kWh more
      ],
      currentSoc: 50,
      batteryKwh: 60,
      chargerPowerKw: 10,
      efficiency: 1,
      houseLoadFactor: 0.7,
      feedInTariffPerKwh: 0,
    });
    expect(r.feasible).toBe(true);
    expect(r.deadlines).toHaveLength(2);
    // First deadline can only use the cheap 14:00 hour (before 20:00).
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).toContain("2026-01-01T14:00:00.000Z");
  });

  it("charges opportunistically below the cheap-price threshold even without target need", () => {
    // Already at target (60%), but one hour is dirt cheap and threshold is set.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.02, 0, "DEFINITE"), // below threshold
      hour("2026-01-01T21:00:00Z", 0.3, 0, "DEFINITE"), // above threshold
    ];
    const r = computePlan({
      ...base,
      currentSoc: 60,
      targetSoc: 60,
      maxSoc: 90,
      cheapPriceThresholdPerKwh: 0.05,
      horizonEnd: H("2026-01-01T22:00:00Z"),
      hours,
    });
    expect(r.energyNeededKwh).toBe(0);
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].hourStart.toISOString()).toBe("2026-01-01T20:00:00.000Z");
    expect(on[0].reason).toBe("cheap");
    expect(r.cheapKwh).toBeGreaterThan(0);
  });

  it("caps opportunistic cheap charging at maxSoc", () => {
    // 60% -> 90% cap = 18 kWh headroom; two 10 kWh cheap hours available, only 18 kWh used.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.01, 0, "DEFINITE"),
      hour("2026-01-01T21:00:00Z", 0.01, 0, "DEFINITE"),
    ];
    const r = computePlan({
      ...base,
      currentSoc: 60,
      targetSoc: 60,
      maxSoc: 90,
      cheapPriceThresholdPerKwh: 0.05,
      horizonEnd: H("2026-01-01T22:00:00Z"),
      hours,
    });
    expect(r.cheapKwh).toBeCloseTo(18, 5);
    expect(r.scheduledKwh).toBeCloseTo(18, 5);
  });

  it("does not mark a target-required hour as cheap even if it also clears the threshold", () => {
    const hours: EngineHour[] = [hour("2026-01-01T20:00:00Z", 0.02, 0, "DEFINITE")];
    const r = computePlan({
      ...base,
      currentSoc: 50,
      targetSoc: 51.66666, // ~1 kWh needed, less than the hour's 10 kWh cap
      cheapPriceThresholdPerKwh: 0.05,
      horizonEnd: H("2026-01-01T21:00:00Z"),
      hours,
    });
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].reason).toBe("target");
  });

  it("does nothing when already at target", () => {
    const r = computePlan({
      ...base,
      currentSoc: 85,
      horizonEnd: H("2026-01-02T07:00:00Z"),
      hours: [hour("2026-01-01T20:00:00Z", 0.1)],
    });
    expect(r.energyNeededKwh).toBe(0);
    expect(r.slots.every((s) => !s.on)).toBe(true);
  });
});
