import { describe, expect, it } from "vitest";
import { median, PowerSample, resolveChargeCommand, SurplusInput } from "./surplus";

const NOW = new Date("2026-06-01T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A run of identical samples, newest first — what the controller normally sees. */
function samples(gridWatts: number, chargerWatts = 0, count = 10): PowerSample[] {
  return Array.from({ length: count }, (_, i) => ({
    at: minutesAgo(i * 0.5),
    gridWatts,
    chargerWatts,
  }));
}

const base: SurplusInput = {
  now: NOW,
  samples: [],
  enabled: true,
  connected: true,
  soc: 50,
  maxSoc: 90,
  planOn: false,
  planAmps: 16,
  phases: 3,
  voltage: 230,
  minCurrentA: 6, // => 4140 W minimum
  maxCurrentA: 16, // => 11040 W maximum
  reserveWatts: 0,
  startDelayMs: 2 * 60_000,
  stopDelayMs: 10 * 60_000,
  surplusSinceAt: minutesAgo(30), // surplus already well established
  deficitSinceAt: null,
  currentMode: "off",
  currentAmps: 0,
};

describe("median", () => {
  it("ignores a single outlier", () => {
    expect(median([100, 100, 100, 100, 9000])).toBe(100);
  });

  it("averages the middle pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("resolveChargeCommand", () => {
  it("follows the surplus once it has held long enough", () => {
    // Exporting 6 kW with the car idle.
    const c = resolveChargeCommand({ ...base, samples: samples(-6000, 0) });
    expect(c.mode).toBe("surplus");
    expect(c.on).toBe(true);
    expect(c.availableWatts).toBe(6000);
    expect(c.amps).toBe(8); // floor(6000 / 690)
  });

  it("adds the car's own draw back before deciding", () => {
    // The meter shows 5 kW of import, but 9 kW of that is the car: the rest of the house
    // is exporting 4 kW. Reading the meter naively here would shut the session down.
    const c = resolveChargeCommand({
      ...base,
      currentMode: "surplus",
      currentAmps: 13,
      samples: samples(5000, 9000),
    });
    expect(c.availableWatts).toBe(4000);
    expect(c.mode).toBe("surplus");
  });

  it("rejects a momentary spike in favour of the median", () => {
    // Nine samples exporting 6 kW, one with the oven on. The mean would drop below the
    // 6 A floor; the median doesn't notice.
    const spiked = [...samples(-6000, 0, 9), { at: NOW, gridWatts: 20000, chargerWatts: 0 }];
    const c = resolveChargeCommand({ ...base, samples: spiked });
    expect(c.mode).toBe("surplus");
    expect(c.amps).toBe(8);
  });

  it("waits out the start delay before beginning a new session", () => {
    const c = resolveChargeCommand({
      ...base,
      samples: samples(-6000, 0),
      surplusSinceAt: null, // surplus only just appeared
    });
    expect(c.on).toBe(false);
    expect(c.surplusSinceAt).toEqual(NOW); // ...but the clock has started
  });

  it("starts immediately once the delay has elapsed", () => {
    const c = resolveChargeCommand({
      ...base,
      samples: samples(-6000, 0),
      surplusSinceAt: minutesAgo(2),
    });
    expect(c.on).toBe(true);
  });

  it("holds a running session at the minimum through a short dip", () => {
    // Only 1 kW of surplus — below the 4.14 kW floor — but the dip is 1 minute old.
    const c = resolveChargeCommand({
      ...base,
      currentMode: "surplus",
      currentAmps: 10,
      samples: samples(-1000, 0),
      surplusSinceAt: null,
      deficitSinceAt: minutesAgo(1),
    });
    expect(c.on).toBe(true);
    expect(c.amps).toBe(6);
    expect(c.reason).toMatch(/dipped/i);
  });

  it("stops once the dip has lasted longer than the stop delay", () => {
    const c = resolveChargeCommand({
      ...base,
      currentMode: "surplus",
      currentAmps: 10,
      samples: samples(-1000, 0),
      surplusSinceAt: null,
      deficitSinceAt: minutesAgo(11),
    });
    expect(c.on).toBe(false);
    expect(c.mode).toBe("off");
  });

  it("lets the plan win over surplus and runs at full power", () => {
    // Barely any surplus, but a deadline needs the car charged.
    const c = resolveChargeCommand({ ...base, planOn: true, samples: samples(2000, 0) });
    expect(c.mode).toBe("plan");
    expect(c.amps).toBe(16);
  });

  it("keeps the hysteresis clock running while the plan is in charge", () => {
    // So a handover to surplus can happen the moment the plan slot ends.
    const c = resolveChargeCommand({
      ...base,
      planOn: true,
      samples: samples(-6000, 0),
      surplusSinceAt: null,
    });
    expect(c.mode).toBe("plan");
    expect(c.surplusSinceAt).toEqual(NOW);
  });

  it("stops at the SoC cap", () => {
    const c = resolveChargeCommand({ ...base, soc: 90, samples: samples(-8000, 0) });
    expect(c.on).toBe(false);
    expect(c.reason).toMatch(/90%/);
  });

  it("does nothing when no car is connected", () => {
    const c = resolveChargeCommand({ ...base, connected: false, samples: samples(-8000, 0) });
    expect(c.on).toBe(false);
  });

  it("does nothing when surplus charging is switched off", () => {
    const c = resolveChargeCommand({ ...base, enabled: false, samples: samples(-8000, 0) });
    expect(c.on).toBe(false);
  });

  it("holds a running session when the meter stops reporting", () => {
    // A sensor gap must not cut a live session short.
    const c = resolveChargeCommand({
      ...base,
      samples: [],
      currentMode: "surplus",
      currentAmps: 11,
    });
    expect(c.on).toBe(true);
    expect(c.amps).toBe(11);
  });

  it("starts nothing when the meter stops reporting", () => {
    const c = resolveChargeCommand({ ...base, samples: [], currentMode: "off" });
    expect(c.on).toBe(false);
    expect(c.availableWatts).toBeNull();
  });

  it("keeps the reserve out of the car's share", () => {
    // 6 kW exporting, 2 kW reserved => 4 kW usable, which is under the 4.14 kW floor.
    const c = resolveChargeCommand({
      ...base,
      reserveWatts: 2000,
      samples: samples(-6000, 0),
    });
    expect(c.availableWatts).toBe(4000);
    expect(c.on).toBe(false);
  });

  it("never commands more than the charger's maximum", () => {
    const c = resolveChargeCommand({ ...base, samples: samples(-30000, 0) });
    expect(c.amps).toBe(16);
  });
});
