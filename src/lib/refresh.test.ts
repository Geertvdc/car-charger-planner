import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsFindUniqueOrThrow = vi.fn();
const powerReadingCreate = vi.fn();
const powerReadingDeleteMany = vi.fn();
const carStateFindFirst = vi.fn();
const carStateCreate = vi.fn();
const planStateUpdate = vi.fn();
const priceSnapshotCount = vi.fn();
const priceSnapshotUpsert = vi.fn();
vi.mock("./db", () => ({
  prisma: {
    settings: { findUniqueOrThrow: (...args: unknown[]) => settingsFindUniqueOrThrow(...args) },
    powerReading: {
      create: (...args: unknown[]) => powerReadingCreate(...args),
      deleteMany: (...args: unknown[]) => powerReadingDeleteMany(...args),
    },
    carState: {
      findFirst: (...args: unknown[]) => carStateFindFirst(...args),
      create: (...args: unknown[]) => carStateCreate(...args),
    },
    planState: { update: (...args: unknown[]) => planStateUpdate(...args) },
    priceSnapshot: {
      count: (...args: unknown[]) => priceSnapshotCount(...args),
      upsert: (...args: unknown[]) => priceSnapshotUpsert(...args),
    },
  },
}));

const getEntityState = vi.fn();
vi.mock("./ha-client", () => ({
  getEntityState: (...args: unknown[]) => getEntityState(...args),
}));

const fetchEnergyZeroDay = vi.fn();
vi.mock("./energyzero", () => ({
  fetchEnergyZeroDay: (...args: unknown[]) => fetchEnergyZeroDay(...args),
}));

import {
  __resetPriceBackfillCache,
  interpretConnectedState,
  refreshCarSoc,
  refreshChargerConnected,
  refreshPowerSample,
  refreshPrices,
} from "./refresh";

describe("refreshPowerSample", () => {
  beforeEach(() => {
    settingsFindUniqueOrThrow.mockReset();
    powerReadingCreate.mockReset().mockResolvedValue({});
    powerReadingDeleteMany.mockReset().mockResolvedValue({ count: 0 });
    getEntityState.mockReset();
  });

  it("no-ops when no power sensor entity is configured", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haPowerSensorEntityId: "" });
    const result = await refreshPowerSample();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(getEntityState).not.toHaveBeenCalled();
  });

  it("no-ops when HA returns no entity (not configured / not found)", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.p1_meter_active_power_w",
    });
    getEntityState.mockResolvedValue(null);
    const result = await refreshPowerSample();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(powerReadingCreate).not.toHaveBeenCalled();
  });

  it("stores a PowerReading on a valid numeric reading", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.p1_meter_active_power_w",
    });
    getEntityState.mockResolvedValue({ state: "1234.5", attributes: {}, last_changed: "" });
    const result = await refreshPowerSample();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(powerReadingCreate).toHaveBeenCalledWith({
      data: { watts: 1234.5, chargerWatts: null, pvWatts: null },
    });
  });

  it("stores grid, charger and PV on one aligned row", async () => {
    // The controller subtracts the charger from the grid figure; taking those from rows
    // seconds apart while the car ramps would invent surplus that isn't there.
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.grid",
      haChargerPowerEntityId: "sensor.charger",
      haSolarPowerEntityId: "sensor.pv",
    });
    getEntityState.mockImplementation(async (id: string) =>
      ({
        "sensor.grid": { state: "-2500", attributes: {}, last_changed: "" },
        "sensor.charger": { state: "3400", attributes: {}, last_changed: "" },
        "sensor.pv": { state: "8100", attributes: {}, last_changed: "" },
      })[id]
    );
    const result = await refreshPowerSample();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(powerReadingCreate).toHaveBeenCalledWith({
      data: { watts: -2500, chargerWatts: 3400, pvWatts: 8100 },
    });
  });

  it("prunes samples older than the retention window", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haPowerSensorEntityId: "sensor.grid" });
    getEntityState.mockResolvedValue({ state: "100", attributes: {}, last_changed: "" });
    await refreshPowerSample();
    expect(powerReadingDeleteMany).toHaveBeenCalled();
  });

  it("fails gracefully on a non-numeric HA state (e.g. 'unavailable')", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.p1_meter_active_power_w",
    });
    getEntityState.mockResolvedValue({ state: "unavailable", attributes: {}, last_changed: "" });
    const result = await refreshPowerSample();
    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(powerReadingCreate).not.toHaveBeenCalled();
  });

  it("returns ok:false without throwing when HA is unreachable", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.p1_meter_active_power_w",
    });
    getEntityState.mockRejectedValue(new Error("fetch failed"));
    const result = await refreshPowerSample();
    expect(result).toEqual({ ok: false, count: 0, error: "fetch failed" });
  });
});

describe("refreshCarSoc", () => {
  beforeEach(() => {
    settingsFindUniqueOrThrow.mockReset();
    carStateFindFirst.mockReset();
    carStateCreate.mockReset().mockResolvedValue({});
    getEntityState.mockReset();
  });

  it("no-ops when no car SoC entity is configured", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "" });
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(getEntityState).not.toHaveBeenCalled();
  });

  it("no-ops when HA returns no entity", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue(null);
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(carStateCreate).not.toHaveBeenCalled();
  });

  it("inserts a CarState row on the first ha_car reading", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "72",
      attributes: {},
      last_changed: "2026-08-07T10:00:00Z",
    });
    carStateFindFirst.mockResolvedValue(null);
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(carStateCreate).toHaveBeenCalledWith({
      data: { soc: 72, source: "ha_car", rawUpdatedAt: new Date("2026-08-07T10:00:00Z") },
    });
  });

  it("no-ops (dedups) when last_changed hasn't advanced since the last ha_car reading", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "72",
      attributes: {},
      last_changed: "2026-08-07T10:00:00Z",
    });
    carStateFindFirst.mockResolvedValue({ rawUpdatedAt: new Date("2026-08-07T10:00:00Z") });
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(carStateCreate).not.toHaveBeenCalled();
  });

  it("inserts a new row once last_changed advances", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "75",
      attributes: {},
      last_changed: "2026-08-07T12:00:00Z",
    });
    carStateFindFirst.mockResolvedValue({ rawUpdatedAt: new Date("2026-08-07T10:00:00Z") });
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(carStateCreate).toHaveBeenCalledWith({
      data: { soc: 75, source: "ha_car", rawUpdatedAt: new Date("2026-08-07T12:00:00Z") },
    });
  });

  it("does not let a stale ha_car poll clobber a more recent manual entry (via dedup)", async () => {
    // The manual entry itself lives in a separate CarState row with a newer `at`, which
    // recomputePlan() already picks by `orderBy: at desc` regardless of source — this
    // test only verifies refreshCarSoc() doesn't insert a duplicate ha_car row for an
    // unchanged reading, which is the mechanism that keeps the manual row on top.
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "72",
      attributes: {},
      last_changed: "2026-08-07T10:00:00Z",
    });
    carStateFindFirst.mockResolvedValue({ rawUpdatedAt: new Date("2026-08-07T10:00:00Z") });
    await refreshCarSoc();
    expect(carStateCreate).not.toHaveBeenCalled();
  });

  it("fails gracefully on an implausible SoC (e.g. 'unavailable')", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "unavailable",
      attributes: {},
      last_changed: "2026-08-07T10:00:00Z",
    });
    const result = await refreshCarSoc();
    expect(result.ok).toBe(false);
    expect(result.count).toBe(0);
    expect(carStateCreate).not.toHaveBeenCalled();
  });

  it("fails gracefully on an out-of-range SoC", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockResolvedValue({
      state: "150",
      attributes: {},
      last_changed: "2026-08-07T10:00:00Z",
    });
    const result = await refreshCarSoc();
    expect(result.ok).toBe(false);
    expect(carStateCreate).not.toHaveBeenCalled();
  });

  it("returns ok:false without throwing when HA is unreachable", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haCarSocEntityId: "sensor.car_soc" });
    getEntityState.mockRejectedValue(new Error("fetch failed"));
    const result = await refreshCarSoc();
    expect(result).toEqual({ ok: false, count: 0, error: "fetch failed" });
  });
});

describe("refreshChargerConnected", () => {
  beforeEach(() => {
    settingsFindUniqueOrThrow.mockReset();
    getEntityState.mockReset();
    planStateUpdate.mockReset().mockResolvedValue({});
  });

  it("no-ops when no connected entity is configured", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haChargerConnectedEntityId: "" });
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(getEntityState).not.toHaveBeenCalled();
    expect(planStateUpdate).not.toHaveBeenCalled();
  });

  it("no-ops when HA returns no entity", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haChargerConnectedEntityId: "binary_sensor.zaptec_go_2_charger",
    });
    getEntityState.mockResolvedValue(null);
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(planStateUpdate).not.toHaveBeenCalled();
  });

  it("stores true when the entity reads 'on'", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haChargerConnectedEntityId: "binary_sensor.zaptec_go_2_charger",
    });
    getEntityState.mockResolvedValue({ state: "on", attributes: {}, last_changed: "" });
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { chargerConnected: true, chargerReportedCharging: false },
    });
  });

  it("stores false when the entity reads anything other than 'on'", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haChargerConnectedEntityId: "binary_sensor.zaptec_go_2_charger",
    });
    getEntityState.mockResolvedValue({ state: "off", attributes: {}, last_changed: "" });
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { chargerConnected: false, chargerReportedCharging: false },
    });
  });

  it("returns ok:false without throwing when HA is unreachable", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      haChargerConnectedEntityId: "binary_sensor.zaptec_go_2_charger",
    });
    getEntityState.mockRejectedValue(new Error("fetch failed"));
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: false, count: 0, error: "fetch failed" });
    expect(planStateUpdate).not.toHaveBeenCalled();
  });
});

describe("refreshPrices backfill", () => {
  const TZ = "Europe/Amsterdam";
  // Fixed clock so "today" is deterministic: 2026-08-09 local.
  const NOW = new Date("2026-08-09T10:00:00Z");

  function settings(historyDays = 3) {
    return {
      timezone: TZ,
      historyDays,
      energyTaxPerKwh: 0.1,
      supplierFeePerKwh: 0.02,
      vatRate: 0.21,
    };
  }

  /** One priced hour, so a fetched day is distinguishable from an empty one. */
  function onePoint(dateISO: string) {
    return [{ hourStart: new Date(`${dateISO}T00:00:00Z`), rawPrice: 0.1 }];
  }

  function fetchedDates() {
    return fetchEnergyZeroDay.mock.calls.map((c) => c[0] as string);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetPriceBackfillCache();
    settingsFindUniqueOrThrow.mockReset().mockResolvedValue(settings());
    priceSnapshotUpsert.mockReset().mockResolvedValue({});
    priceSnapshotCount.mockReset().mockResolvedValue(96); // history complete by default (96 x 15-min slots)
    fetchEnergyZeroDay.mockReset().mockImplementation((d: string) => onePoint(d));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches only today and tomorrow when history is already complete", async () => {
    const result = await refreshPrices();
    expect(fetchedDates()).toEqual(["2026-08-09", "2026-08-10"]);
    expect(result.ok).toBe(true);
  });

  it("backfills a past day that is missing entirely", async () => {
    // 2026-08-07 has no stored hours; the other history days are complete.
    priceSnapshotCount.mockImplementation(({ where }: { where: { hourStart: { gte: Date } } }) =>
      where.hourStart.gte.toISOString().startsWith("2026-08-06") ? 0 : 96
    );
    const result = await refreshPrices();
    expect(fetchedDates()).toContain("2026-08-07");
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3); // today + tomorrow + the backfilled day
  });

  it("backfills a partially stored day (interrupted mid-fetch)", async () => {
    priceSnapshotCount.mockResolvedValue(40);
    await refreshPrices();
    expect(fetchedDates()).toEqual([
      "2026-08-09",
      "2026-08-10",
      "2026-08-08",
      "2026-08-07",
      "2026-08-06",
    ]);
  });

  it("honours historyDays as the backfill window", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue(settings(1));
    priceSnapshotCount.mockResolvedValue(0);
    await refreshPrices();
    expect(fetchedDates()).toEqual(["2026-08-09", "2026-08-10", "2026-08-08"]);
  });

  it("stops retrying a past day EnergyZero has no prices for", async () => {
    priceSnapshotCount.mockResolvedValue(0);
    fetchEnergyZeroDay.mockImplementation((d: string) => (d >= "2026-08-09" ? onePoint(d) : []));

    await refreshPrices();
    expect(fetchedDates()).toContain("2026-08-08");

    fetchEnergyZeroDay.mockClear();
    await refreshPrices();
    // Second pass: today/tomorrow only — the empty history days aren't asked again.
    expect(fetchedDates()).toEqual(["2026-08-09", "2026-08-10"]);
  });

  it("keeps today/tomorrow's prices when a backfill day fails", async () => {
    priceSnapshotCount.mockResolvedValue(0);
    fetchEnergyZeroDay.mockImplementation((d: string) => {
      if (d === "2026-08-08") throw new Error("EnergyZero 503");
      return onePoint(d);
    });
    const result = await refreshPrices();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2026-08-08");
    expect(result.count).toBe(4); // today, tomorrow, and the two history days that worked
    expect(priceSnapshotUpsert).toHaveBeenCalledTimes(4);
  });

  it("retries a failed backfill day on the next refresh", async () => {
    priceSnapshotCount.mockResolvedValue(0);
    fetchEnergyZeroDay.mockImplementationOnce((d: string) => onePoint(d)) // today
      .mockImplementationOnce((d: string) => onePoint(d)) // tomorrow
      .mockImplementationOnce(() => {
        throw new Error("network");
      });
    await refreshPrices();

    fetchEnergyZeroDay.mockClear().mockImplementation((d: string) => onePoint(d));
    await refreshPrices();
    expect(fetchedDates()).toContain("2026-08-08");
  });
});

describe("interpretConnectedState", () => {
  it("reads a plain binary_sensor", () => {
    expect(interpretConnectedState("on")).toBe(true);
    expect(interpretConnectedState("off")).toBe(false);
  });

  it("reads the Zaptec charger_mode enum", () => {
    // Options published by the entity:
    // unknown | disconnected | connected_requesting | connected_charging | connected_finished
    expect(interpretConnectedState("disconnected")).toBe(false);
    expect(interpretConnectedState("connected_requesting")).toBe(true);
    expect(interpretConnectedState("connected_charging")).toBe(true);
    expect(interpretConnectedState("connected_finished")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(interpretConnectedState(" Connected_Charging ")).toBe(true);
    expect(interpretConnectedState("DISCONNECTED")).toBe(false);
  });

  it("returns null for states that cannot answer, so the last value is kept", () => {
    expect(interpretConnectedState("unknown")).toBeNull();
    expect(interpretConnectedState("unavailable")).toBeNull();
    expect(interpretConnectedState("")).toBeNull();
    expect(interpretConnectedState(undefined)).toBeNull();
    expect(interpretConnectedState("something_new")).toBeNull();
  });
});

describe("refreshChargerConnected", () => {
  beforeEach(() => {
    settingsFindUniqueOrThrow.mockReset().mockResolvedValue({
      haChargerConnectedEntityId: "sensor.zaptec_go_2_charger_mode",
    });
    planStateUpdate.mockReset().mockResolvedValue({});
    getEntityState.mockReset();
  });

  it("stores connected=true and reportedCharging=true while actively charging", async () => {
    getEntityState.mockResolvedValue({ state: "connected_charging", attributes: {}, last_changed: "" });
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 1 });
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { chargerConnected: true, chargerReportedCharging: true },
    });
  });

  it("stores connected=true but reportedCharging=false when plugged in but not drawing power", async () => {
    getEntityState.mockResolvedValue({ state: "connected_requesting", attributes: {}, last_changed: "" });
    await refreshChargerConnected();
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { chargerConnected: true, chargerReportedCharging: false },
    });
  });

  it("stores connected=false once the cable is out", async () => {
    getEntityState.mockResolvedValue({ state: "disconnected", attributes: {}, last_changed: "" });
    await refreshChargerConnected();
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { chargerConnected: false, chargerReportedCharging: false },
    });
  });

  it("leaves the stored value alone when the entity goes unavailable", async () => {
    getEntityState.mockResolvedValue({ state: "unavailable", attributes: {}, last_changed: "" });
    const result = await refreshChargerConnected();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(planStateUpdate).not.toHaveBeenCalled();
  });

  it("no-ops when no entity is configured", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ haChargerConnectedEntityId: "" });
    expect(await refreshChargerConnected()).toEqual({ ok: true, count: 0 });
    expect(getEntityState).not.toHaveBeenCalled();
  });
});
