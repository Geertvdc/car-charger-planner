import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsFindUnique = vi.fn();
const settingsUpdate = vi.fn();
vi.mock("./db", () => ({
  prisma: {
    settings: {
      findUnique: (...args: unknown[]) => settingsFindUnique(...args),
      update: (...args: unknown[]) => settingsUpdate(...args),
    },
  },
}));

import { seedSettingsFromEnv } from "./bootstrap";

const ENV_VARS = [
  "HA_BASE_URL",
  "HA_ACCESS_TOKEN",
  "HA_CHARGER_SWITCH_ENTITY_ID",
  "HA_CHARGER_STATUS_ENTITY_ID",
  "HA_CHARGER_CONNECTED_ENTITY_ID",
  "HA_POWER_SENSOR_ENTITY_ID",
  "HA_CAR_SOC_ENTITY_ID",
  "HA_CHARGER_ON_SERVICE",
  "HA_CHARGER_OFF_SERVICE",
];

/** A freshly created Settings row: every seedable field at its Prisma default. */
function freshSettings() {
  return {
    haBaseUrl: "",
    haAccessToken: "",
    haChargerSwitchEntityId: "",
    haChargerStatusEntityId: "",
    haChargerConnectedEntityId: "",
    haPowerSensorEntityId: "",
    haCarSocEntityId: "",
    haChargerOnService: "switch.turn_on",
    haChargerOffService: "switch.turn_off",
  };
}

describe("seedSettingsFromEnv", () => {
  beforeEach(() => {
    settingsFindUnique.mockReset().mockResolvedValue(freshSettings());
    settingsUpdate.mockReset().mockResolvedValue({});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const v of ENV_VARS) delete process.env[v];
    vi.restoreAllMocks();
  });

  it("does nothing when no HA env vars are set", async () => {
    expect(await seedSettingsFromEnv()).toEqual([]);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it("copies entity IDs into a fresh database", async () => {
    process.env.HA_CHARGER_SWITCH_ENTITY_ID = "switch.zaptec_go_2_charging";
    process.env.HA_CAR_SOC_ENTITY_ID = "sensor.alldata_hv_battery_level";
    const applied = await seedSettingsFromEnv();
    expect(applied).toEqual(["haChargerSwitchEntityId", "haCarSocEntityId"]);
    expect(settingsUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        haChargerSwitchEntityId: "switch.zaptec_go_2_charging",
        haCarSocEntityId: "sensor.alldata_hv_battery_level",
      },
    });
  });

  it("seeds the base URL and token, trimming a trailing slash from the URL", async () => {
    process.env.HA_BASE_URL = "https://home.example.cloud:8443/";
    process.env.HA_ACCESS_TOKEN = "a-token";
    await seedSettingsFromEnv();
    expect(settingsUpdate.mock.calls[0][0].data).toEqual({
      haBaseUrl: "https://home.example.cloud:8443",
      haAccessToken: "a-token",
    });
  });

  it("never overwrites a field already edited in the UI", async () => {
    settingsFindUnique.mockResolvedValue({
      ...freshSettings(),
      haCarSocEntityId: "sensor.cupra_battery",
    });
    process.env.HA_CAR_SOC_ENTITY_ID = "sensor.alldata_hv_battery_level";
    process.env.HA_POWER_SENSOR_ENTITY_ID = "sensor.p1_active_power";
    const applied = await seedSettingsFromEnv();
    expect(applied).toEqual(["haPowerSensorEntityId"]);
    expect(settingsUpdate.mock.calls[0][0].data).toEqual({
      haPowerSensorEntityId: "sensor.p1_active_power",
    });
  });

  it("seeds the service fields only while they hold the built-in default", async () => {
    settingsFindUnique.mockResolvedValue({
      ...freshSettings(),
      haChargerOffService: "zaptec.stop_charging",
    });
    process.env.HA_CHARGER_ON_SERVICE = "zaptec.start_charging";
    process.env.HA_CHARGER_OFF_SERVICE = "something.else";
    const applied = await seedSettingsFromEnv();
    expect(applied).toEqual(["haChargerOnService"]);
  });

  it("ignores blank and whitespace-only env values", async () => {
    process.env.HA_CAR_SOC_ENTITY_ID = "   ";
    process.env.HA_POWER_SENSOR_ENTITY_ID = "";
    expect(await seedSettingsFromEnv()).toEqual([]);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op when the Settings row doesn't exist yet", async () => {
    settingsFindUnique.mockResolvedValue(null);
    process.env.HA_CAR_SOC_ENTITY_ID = "sensor.x";
    expect(await seedSettingsFromEnv()).toEqual([]);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent: a second boot with the same env changes nothing", async () => {
    process.env.HA_CAR_SOC_ENTITY_ID = "sensor.alldata_hv_battery_level";
    await seedSettingsFromEnv();
    settingsFindUnique.mockResolvedValue({
      ...freshSettings(),
      haCarSocEntityId: "sensor.alldata_hv_battery_level",
    });
    settingsUpdate.mockClear();
    expect(await seedSettingsFromEnv()).toEqual([]);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it("does not log the token value", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.HA_ACCESS_TOKEN = "super-secret-token";
    await seedSettingsFromEnv();
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("haAccessToken");
    expect(logged).not.toContain("super-secret-token");
  });
});
