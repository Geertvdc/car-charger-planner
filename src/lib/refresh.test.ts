import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsFindUniqueOrThrow = vi.fn();
const powerReadingCreate = vi.fn();
const powerReadingDeleteMany = vi.fn();
const powerReadingFindMany = vi.fn();
const carStateFindFirst = vi.fn();
const carStateCreate = vi.fn();
const planStateUpdate = vi.fn();
const priceSnapshotCount = vi.fn();
const priceSnapshotUpsert = vi.fn();
const solarForecastUpsert = vi.fn();
vi.mock("./db", () => ({
  prisma: {
    settings: { findUniqueOrThrow: (...args: unknown[]) => settingsFindUniqueOrThrow(...args) },
    powerReading: {
      create: (...args: unknown[]) => powerReadingCreate(...args),
      deleteMany: (...args: unknown[]) => powerReadingDeleteMany(...args),
      findMany: (...args: unknown[]) => powerReadingFindMany(...args),
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
    solarForecast: {
      upsert: (...args: unknown[]) => solarForecastUpsert(...args),
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

// Empty by default so refreshPrices() falls through to the EnergyZero mock above,
// matching all the existing backfill/error tests below. Tests exercising Nordpool
// itself override this per-case.
const fetchNordpoolDay = vi.fn().mockResolvedValue([]);
vi.mock("./nordpool", () => ({
  fetchNordpoolDay: (...args: unknown[]) => fetchNordpoolDay(...args),
}));

const fetchForecastSolar = vi.fn();
vi.mock("./forecastsolar", () => ({
  fetchForecastSolar: (...args: unknown[]) => fetchForecastSolar(...args),
}));

import {
  __resetPriceBackfillCache,
  interpretConnectedState,
  refreshCarSoc,
  refreshChargerConnected,
  refreshPowerSample,
  refreshPrices,
  refreshSolar,
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
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.grid",
      historyDays: 3,
    });
    getEntityState.mockResolvedValue({ state: "100", attributes: {}, last_changed: "" });
    await refreshPowerSample();
    expect(powerReadingDeleteMany).toHaveBeenCalled();
  });

  it("keeps retention at least as long as the dashboard's history window", async () => {
    // historyDays=3 means the oldest displayed day is ~3 days back; the retention
    // cutoff must sit before that, or that day's chart loses its data mid-day as the
    // cutoff sweeps across it — it must not be pinned to a fixed short window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.grid",
      historyDays: 5,
    });
    getEntityState.mockResolvedValue({ state: "100", attributes: {}, last_changed: "" });
    await refreshPowerSample();
    const cutoff = (powerReadingDeleteMany.mock.calls[0][0] as { where: { at: { lt: Date } } })
      .where.at.lt;
    expect(cutoff.getTime()).toBeLessThanOrEqual(new Date("2026-08-16T12:00:00Z").getTime());
    vi.useRealTimers();
  });

  it("keeps retention at least as long as refreshSolar()'s history lookback, even with a short historyDays", async () => {
    // historyDays=1 alone would only need 2 days, but refreshSolar() averages over a
    // wider window (14 days) to estimate production — retention must cover that too.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00Z"));
    settingsFindUniqueOrThrow.mockResolvedValue({
      haPowerSensorEntityId: "sensor.grid",
      historyDays: 1,
    });
    getEntityState.mockResolvedValue({ state: "100", attributes: {}, last_changed: "" });
    await refreshPowerSample();
    const cutoff = (powerReadingDeleteMany.mock.calls[0][0] as { where: { at: { lt: Date } } })
      .where.at.lt;
    expect(cutoff.getTime()).toBeLessThanOrEqual(new Date("2026-08-07T12:00:00Z").getTime());
    vi.useRealTimers();
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

describe("refreshSolar", () => {
  const TZ = "Europe/Amsterdam";
  const NOW = new Date("2026-08-09T10:00:00Z"); // 12:00 local (CEST, UTC+2)

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    settingsFindUniqueOrThrow.mockReset().mockResolvedValue({ timezone: TZ, solarKwp: 0 });
    powerReadingFindMany.mockReset().mockResolvedValue([]);
    solarForecastUpsert.mockReset().mockResolvedValue({});
    // Empty by default so tests that don't set solarKwp fall straight through to the
    // history estimate below, unaffected by this mock.
    fetchForecastSolar.mockReset().mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("no-ops when there's no measured PV history yet", async () => {
    const result = await refreshSolar();
    expect(result).toEqual({ ok: true, count: 0 });
    expect(solarForecastUpsert).not.toHaveBeenCalled();
  });

  it("skips Forecast.Solar entirely when solarKwp is unset", async () => {
    await refreshSolar();
    expect(fetchForecastSolar).not.toHaveBeenCalled();
  });

  it("uses Forecast.Solar when solarKwp is configured, in preference to history", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({
      timezone: TZ,
      latitude: 52.37,
      longitude: 4.9,
      solarKwp: 10.18,
      solarTilt: 10,
      solarAzimuth: -106,
    });
    fetchForecastSolar.mockResolvedValue(
      new Map([
        [new Date("2026-08-09T10:00:00Z").getTime(), 2000],
        [new Date("2026-08-09T11:00:00Z").getTime(), 2500],
      ])
    );
    const result = await refreshSolar();
    expect(result).toEqual({ ok: true, count: 2 });
    expect(fetchForecastSolar).toHaveBeenCalledWith(
      { lat: 52.37, lon: 4.9, tilt: 10, azimuth: -106, kwp: 10.18 },
      TZ
    );
    // History wasn't even queried — Forecast.Solar covered it.
    expect(powerReadingFindMany).not.toHaveBeenCalled();
  });

  it("falls back to the history estimate when Forecast.Solar fails", async () => {
    settingsFindUniqueOrThrow.mockResolvedValue({ timezone: TZ, solarKwp: 10.18 });
    fetchForecastSolar.mockRejectedValue(new Error("Forecast.Solar 429"));
    powerReadingFindMany.mockResolvedValue([
      { at: new Date("2026-08-07T10:00:00Z"), pvWatts: 3000 },
    ]);
    const result = await refreshSolar();
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2); // today + tomorrow, from history
  });

  it("averages measured watts by local hour-of-day into today and tomorrow's forecast", async () => {
    powerReadingFindMany.mockResolvedValue([
      { at: new Date("2026-08-07T10:00:00Z"), pvWatts: 3000 }, // local 12:00
      { at: new Date("2026-08-08T10:00:00Z"), pvWatts: 5000 }, // local 12:00
    ]);
    const result = await refreshSolar();
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2); // today + tomorrow, the one hour with history
    const call = solarForecastUpsert.mock.calls[0][0] as { create: { expectedWh: number } };
    expect(call.create.expectedWh).toBe(4000); // average of 3000 and 5000
  });

  it("skips hours with no history rather than writing a false zero", async () => {
    powerReadingFindMany.mockResolvedValue([
      { at: new Date("2026-08-07T10:00:00Z"), pvWatts: 3000 }, // only local hour 12 populated
    ]);
    await refreshSolar();
    expect(solarForecastUpsert).toHaveBeenCalledTimes(2); // today + tomorrow, that one hour only
  });

  it("clamps a negative sensor reading to zero", async () => {
    powerReadingFindMany.mockResolvedValue([
      { at: new Date("2026-08-07T02:00:00Z"), pvWatts: -3 }, // nighttime sensor noise
    ]);
    await refreshSolar();
    const call = solarForecastUpsert.mock.calls[0][0] as { create: { expectedWh: number } };
    expect(call.create.expectedWh).toBe(0);
  });

  it("returns ok:false without throwing on a DB error", async () => {
    powerReadingFindMany.mockRejectedValue(new Error("db down"));
    const result = await refreshSolar();
    expect(result).toEqual({ ok: false, count: 0, error: "db down" });
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
    fetchNordpoolDay.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches only today and tomorrow when history is already complete", async () => {
    const result = await refreshPrices();
    expect(fetchedDates()).toEqual(["2026-08-09", "2026-08-10"]);
    expect(result.ok).toBe(true);
  });

  it("prefers Nordpool's real 15-min prices and skips EnergyZero when it succeeds", async () => {
    fetchNordpoolDay.mockImplementation((d: string) => onePoint(d));
    const result = await refreshPrices();
    expect(result.ok).toBe(true);
    expect(fetchEnergyZeroDay).not.toHaveBeenCalled();
    expect(fetchNordpoolDay).toHaveBeenCalledWith("2026-08-09");
    expect(fetchNordpoolDay).toHaveBeenCalledWith("2026-08-10");
  });

  it("falls back to EnergyZero for a day Nordpool errors on", async () => {
    fetchNordpoolDay.mockImplementation((d: string) =>
      d === "2026-08-09" ? Promise.reject(new Error("Nordpool 503")) : onePoint(d)
    );
    const result = await refreshPrices();
    expect(result.ok).toBe(true);
    expect(fetchedDates()).toEqual(["2026-08-09"]); // only the day Nordpool failed for
  });

  it("falls back to EnergyZero for a day Nordpool has nothing for yet", async () => {
    // e.g. tomorrow, before Nordpool's auction has published.
    fetchNordpoolDay.mockImplementation((d: string) => (d === "2026-08-10" ? [] : onePoint(d)));
    const result = await refreshPrices();
    expect(result.ok).toBe(true);
    expect(fetchedDates()).toEqual(["2026-08-10"]);
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
