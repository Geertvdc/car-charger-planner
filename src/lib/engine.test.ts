import { describe, expect, it } from "vitest";
import { computeMultiPlan, computePlan, EngineHour } from "./engine";
import type { AvailStatus } from "./availability";

const H = (iso: string) => new Date(iso);

function hour(
  iso: string,
  price: number,
  solarWh = 0,
  availability: AvailStatus = "HOME",
  feedInPrice = 0
): EngineHour {
  return { hourStart: H(iso), allInPrice: price, feedInPrice, solarWh, availability };
}

const base = {
  now: H("2026-01-01T20:00:00Z"),
  currentSoc: 50,
  targetSoc: 80,
  batteryKwh: 60, // need (80-50)% * 60 = 18 kWh into battery
  chargerPowerKw: 10,
  efficiency: 1, // simplify: 10 kWh/h into battery
  houseLoadFactor: 0.7,
};

// Default electrical envelope is 3-phase 230 V 6–16 A, so the minimum a surplus slot
// must be able to carry is 6 * 3 * 230 = 4.14 kW.
const MIN_SURPLUS_KW = 4.14;

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
      hour("2026-01-01T20:00:00Z", 0.2, 0, "HOME"),
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

  it("never charges during away hours", () => {
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.05, 0, "AWAY"), // cheap but away
      hour("2026-01-01T21:00:00Z", 0.5, 0, "HOME"),
      hour("2026-01-01T22:00:00Z", 0.5, 0, "HOME"),
    ];
    const r = computePlan({
      ...base,
      horizonEnd: H("2026-01-01T23:00:00Z"),
      hours,
    });
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).not.toContain("2026-01-01T20:00:00.000Z");
    expect(r.feasible).toBe(true);
  });

  it("uses a cheap window the day before ahead of an expensive night", () => {
    // Deadline tomorrow 07:00. A cheap home afternoon today vs an expensive home night.
    const hours: EngineHour[] = [
      hour("2026-01-01T14:00:00Z", 0.1, 0, "HOME"), // cheap afternoon
      hour("2026-01-01T15:00:00Z", 0.1, 0, "HOME"),
      hour("2026-01-02T02:00:00Z", 0.6, 0, "HOME"), // expensive night
      hour("2026-01-02T03:00:00Z", 0.6, 0, "HOME"),
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
    });
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).toContain("2026-01-01T14:00:00.000Z"); // cheap afternoon used
    expect(on).toContain("2026-01-01T15:00:00.000Z");
    expect(on).not.toContain("2026-01-02T02:00:00.000Z"); // expensive night avoided
    expect(r.feasible).toBe(true);
  });

  it("satisfies two deadlines, banking cheap energy for later", () => {
    const hours: EngineHour[] = [
      hour("2026-01-01T14:00:00Z", 0.05, 0, "HOME"), // very cheap
      hour("2026-01-01T22:00:00Z", 0.4, 0, "HOME"),
      hour("2026-01-02T14:00:00Z", 0.05, 0, "HOME"), // very cheap next day
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
      hour("2026-01-01T20:00:00Z", 0.02, 0, "HOME"), // below threshold
      hour("2026-01-01T21:00:00Z", 0.3, 0, "HOME"), // above threshold
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
      hour("2026-01-01T20:00:00Z", 0.01, 0, "HOME"),
      hour("2026-01-01T21:00:00Z", 0.01, 0, "HOME"),
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
    const hours: EngineHour[] = [hour("2026-01-01T20:00:00Z", 0.02, 0, "HOME")];
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

  it("scales energy/cost to a 15-min slotHours instead of a full hour", () => {
    // Same 10 kW charger, but each bucket is a 15-min slot: full-power cap per slot
    // is 2.5 kWh (10 kW * 0.25 h), not 10 kWh. Still picks the cheapest slots first.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.5),
      hour("2026-01-01T20:15:00Z", 0.1), // cheapest
      hour("2026-01-01T20:30:00Z", 0.2),
      hour("2026-01-01T20:45:00Z", 0.5),
    ];
    const r = computePlan({
      ...base,
      currentSoc: 50,
      targetSoc: 54, // need 2.4 kWh into battery, less than one full slot (2.5 kWh)
      horizonEnd: H("2026-01-01T21:00:00Z"),
      hours,
      slotHours: 0.25,
    });
    expect(r.feasible).toBe(true);
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].hourStart.toISOString()).toBe("2026-01-01T20:15:00.000Z"); // cheapest slot
    expect(on[0].kwh).toBeCloseTo(2.4, 5);
    expect(on[0].cost).toBeCloseTo(2.4 * 0.1, 5);
    expect(r.scheduledKwh).toBeCloseTo(2.4, 5);
  });
});

describe("solar surplus pass", () => {
  // Already at target, no cheap threshold set: nothing but the surplus rule can schedule
  // anything here, which is the point — surplus charging is worth doing on its own.
  const atTarget = {
    ...base,
    houseLoadFactor: 1,
    currentSoc: 60,
    targetSoc: 60,
    maxSoc: 90, // 60% -> 90% of 60 kWh = 18 kWh of headroom
    horizonEnd: H("2026-01-01T23:00:00Z"),
  };

  it("charges from forecast surplus with no target need and no cheap threshold", () => {
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.3, 0, "HOME", 0.12), // dark
      hour("2026-01-01T21:00:00Z", 0.3, 12000, "HOME", 0.12), // 12 kW of PV
    ];
    const r = computePlan({ ...atTarget, hours });

    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].hourStart.toISOString()).toBe("2026-01-01T21:00:00.000Z");
    expect(on[0].reason).toBe("surplus");
    expect(on[0].source).toBe("solar");
    expect(r.surplusKwh).toBeGreaterThan(0);
    // Costed on the forgone export only — no grid component at all.
    expect(on[0].effectiveCostPerKwh).toBeCloseTo(0.12, 5);
  });

  it("only takes what the sun can carry, not the charger's full power", () => {
    // 6 kW of PV against a 10 kW charger: the slot is worth 6 kWh, not 10.
    const hours: EngineHour[] = [hour("2026-01-01T21:00:00Z", 0.3, 6000, "HOME", 0.1)];
    const r = computePlan({ ...atTarget, hours });

    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].kwh).toBeCloseTo(6, 5);
    expect(on[0].cost).toBeCloseTo(6 * 0.1, 5);
  });

  it("runs a surplus slot at the current the sun supports, not full current", () => {
    // 6 kW over 3 phases at 230 V = 8.7 A, which rounds to 9 A — not the 16 A max.
    const hours: EngineHour[] = [hour("2026-01-01T21:00:00Z", 0.3, 6000, "HOME", 0.1)];
    const r = computePlan({ ...atTarget, hours });
    expect(r.slots.filter((s) => s.on)[0].amps).toBe(9);
  });

  it("ignores a slot whose PV can't reach the charger's minimum current", () => {
    // 3 kW of PV is below the 3-phase 6 A floor of 4.14 kW: the car would refuse to draw.
    const hours: EngineHour[] = [
      hour("2026-01-01T21:00:00Z", 0.3, 3000, "HOME", 0.1),
      hour("2026-01-01T22:00:00Z", 0.3, 5000, "HOME", 0.1), // above the floor
    ];
    const r = computePlan({ ...atTarget, hours });
    const on = r.slots.filter((s) => s.on).map((s) => s.hourStart.toISOString());
    expect(on).toEqual(["2026-01-01T22:00:00.000Z"]);
    expect(3).toBeLessThan(MIN_SURPLUS_KW);
  });

  it("picks up smaller surplus on a single phase", () => {
    // Same 3 kW slot, but 1-phase drops the floor to 1.38 kW.
    const hours: EngineHour[] = [hour("2026-01-01T21:00:00Z", 0.3, 3000, "HOME", 0.1)];
    const r = computePlan({ ...atTarget, hours, phases: 1 });
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].reason).toBe("surplus");
    expect(on[0].amps).toBe(13); // 3000 W / 230 V
  });

  it("caps surplus charging at maxSoc", () => {
    // Three 10 kW-of-PV hours = 30 kWh available, but only 18 kWh of headroom.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.3, 10000, "HOME", 0.1),
      hour("2026-01-01T21:00:00Z", 0.3, 10000, "HOME", 0.1),
      hour("2026-01-01T22:00:00Z", 0.3, 10000, "HOME", 0.1),
    ];
    const r = computePlan({ ...atTarget, hours });
    expect(r.surplusKwh).toBeCloseTo(18, 5);
    expect(r.scheduledKwh).toBeCloseTo(18, 5);
  });

  it("keeps a solar hour needed for a target labelled target, not surplus", () => {
    // A slot already charging at full power for a deadline is self-consuming all its PV
    // anyway, so there is no extra surplus to claim there.
    const hours: EngineHour[] = [hour("2026-01-01T20:00:00Z", 0.3, 12000, "HOME", 0.12)];
    const r = computePlan({
      ...base,
      houseLoadFactor: 1,
      currentSoc: 50,
      targetSoc: 55, // 3 kWh needed
      horizonEnd: H("2026-01-01T21:00:00Z"),
      hours,
    });
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].reason).toBe("target");
    expect(on[0].amps).toBe(16); // full power for a deadline
  });

  it("prefers surplus over a grid hour that also clears the cheap threshold", () => {
    // Surplus energy costs the forgone export (0.05); the cheap grid hour costs 0.08.
    // Only 6 kWh of headroom, so the engine has to choose.
    const hours: EngineHour[] = [
      hour("2026-01-01T20:00:00Z", 0.08, 0, "HOME", 0.05), // cheap grid
      hour("2026-01-01T21:00:00Z", 0.3, 10000, "HOME", 0.05), // surplus
    ];
    const r = computePlan({
      ...atTarget,
      maxSoc: 70, // 60% -> 70% of 60 kWh = 6 kWh of headroom
      cheapPriceThresholdPerKwh: 0.1,
      hours,
    });
    const on = r.slots.filter((s) => s.on);
    expect(on).toHaveLength(1);
    expect(on[0].hourStart.toISOString()).toBe("2026-01-01T21:00:00.000Z");
    expect(on[0].reason).toBe("surplus");
  });

  it("treats a negative export price as surplus charging that pays", () => {
    // When the market price goes negative you pay to export, so soaking it up is
    // worth more than free — feedInPrice must not be clamped at 0.
    const hours: EngineHour[] = [hour("2026-01-01T21:00:00Z", 0.05, 10000, "HOME", -0.03)];
    const r = computePlan({ ...atTarget, hours });
    const on = r.slots.filter((s) => s.on);
    expect(on[0].reason).toBe("surplus");
    expect(on[0].effectiveCostPerKwh).toBeCloseTo(-0.03, 5);
    expect(r.totalCost).toBeLessThan(0);
  });
});
