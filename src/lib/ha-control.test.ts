import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsFindUnique = vi.fn();
const planStateFindUnique = vi.fn();
const planStateUpdate = vi.fn();
vi.mock("./db", () => ({
  prisma: {
    settings: { findUnique: (...args: unknown[]) => settingsFindUnique(...args) },
    planState: {
      findUnique: (...args: unknown[]) => planStateFindUnique(...args),
      update: (...args: unknown[]) => planStateUpdate(...args),
    },
  },
}));

const callHaService = vi.fn();
vi.mock("./ha-client", () => ({
  callHaService: (...args: unknown[]) => callHaService(...args),
}));

import { chargerControlStatus, syncChargerState } from "./ha-control";

describe("syncChargerState", () => {
  beforeEach(() => {
    settingsFindUnique.mockReset();
    planStateFindUnique.mockReset();
    planStateUpdate.mockReset().mockResolvedValue({});
    callHaService.mockReset();
    // Tests run with NODE_ENV=test, where control is off by default. These cases are
    // about the push logic itself, so opt in explicitly; the gate has its own tests.
    vi.stubEnv("ALLOW_CHARGER_CONTROL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("no-ops when no charger switch entity is configured", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "" });
    await syncChargerState(true);
    expect(callHaService).not.toHaveBeenCalled();
    expect(planStateFindUnique).not.toHaveBeenCalled();
  });

  it("never pushes to HA while simulation mode is active, even if fully configured", async () => {
    settingsFindUnique.mockResolvedValue({
      haChargerSwitchEntityId: "switch.zaptec_go_2",
      simulatedNow: new Date("2026-01-01T12:00:00Z"),
    });
    await syncChargerState(true);
    expect(callHaService).not.toHaveBeenCalled();
    expect(planStateFindUnique).not.toHaveBeenCalled();
  });

  it("no-ops when already in sync", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({ haSyncOn: true });
    await syncChargerState(true);
    expect(callHaService).not.toHaveBeenCalled();
  });

  it("calls switch.turn_on and records success when turning on", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(true);
    expect(callHaService).toHaveBeenCalledWith("switch", "turn_on", {
      entity_id: "switch.zaptec_go_2",
    });
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ haSyncOn: true, haSyncError: null }),
    });
  });

  it("calls switch.turn_off when turning off", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({ haSyncOn: true });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(false);
    expect(callHaService).toHaveBeenCalledWith("switch", "turn_off", {
      entity_id: "switch.zaptec_go_2",
    });
  });

  it("records the error and leaves haSyncOn untouched on failure", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false });
    callHaService.mockRejectedValue(new Error("HA unreachable"));
    await syncChargerState(true);
    expect(planStateUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { haSyncError: "HA unreachable" },
    });
    const call = planStateUpdate.mock.calls[0][0];
    expect(call.data.haSyncOn).toBeUndefined();
  });

  it("never throws even if callHaService and the DB update both fail", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false });
    callHaService.mockRejectedValue(new Error("HA unreachable"));
    planStateUpdate.mockRejectedValue(new Error("db locked"));
    await expect(syncChargerState(true)).resolves.toBeUndefined();
  });

  it("rate-limits: skips the push when the decision changed but the last push was <1 min ago", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({
      haSyncOn: false,
      haSyncAt: new Date(Date.now() - 30_000), // 30s ago, within the 1 min cooldown
    });
    await syncChargerState(true);
    expect(callHaService).not.toHaveBeenCalled();
    expect(planStateUpdate).not.toHaveBeenCalled();
  });

  it("rate-limits: pushes again once the cooldown has elapsed", async () => {
    settingsFindUnique.mockResolvedValue({ haChargerSwitchEntityId: "switch.zaptec_go_2" });
    planStateFindUnique.mockResolvedValue({
      haSyncOn: false,
      haSyncAt: new Date(Date.now() - 61_000), // just past the 1 min cooldown
    });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(true);
    expect(callHaService).toHaveBeenCalledWith("switch", "turn_on", {
      entity_id: "switch.zaptec_go_2",
    });
  });

  it("uses a configured domain.service instead of the switch default", async () => {
    settingsFindUnique.mockResolvedValue({
      haChargerSwitchEntityId: "switch.zaptec_go_2",
      haChargerOnService: "zaptec.start_charging",
      haChargerOffService: "zaptec.stop_charging",
    });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(true);
    expect(callHaService).toHaveBeenCalledWith("zaptec", "start_charging", {
      entity_id: "switch.zaptec_go_2",
    });

    planStateFindUnique.mockResolvedValue({ haSyncOn: true });
    await syncChargerState(false);
    expect(callHaService).toHaveBeenLastCalledWith("zaptec", "stop_charging", {
      entity_id: "switch.zaptec_go_2",
    });
  });

  it("falls back to the switch default when the configured service is malformed or empty", async () => {
    settingsFindUnique.mockResolvedValue({
      haChargerSwitchEntityId: "switch.zaptec_go_2",
      haChargerOnService: "not-a-valid-service",
      haChargerOffService: "",
    });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(true);
    expect(callHaService).toHaveBeenCalledWith("switch", "turn_on", {
      entity_id: "switch.zaptec_go_2",
    });

    planStateFindUnique.mockResolvedValue({ haSyncOn: true });
    await syncChargerState(false);
    expect(callHaService).toHaveBeenLastCalledWith("switch", "turn_off", {
      entity_id: "switch.zaptec_go_2",
    });
  });
});

describe("chargerControlStatus", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off outside production, so a dev copy never drives real hardware", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(chargerControlStatus()).toEqual({ enabled: false, reason: "non-production" });
  });

  it("is on in production (Docker and the add-on both set NODE_ENV=production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(chargerControlStatus()).toEqual({ enabled: true, reason: "production" });
  });

  it("can be forced on from a dev copy to test control deliberately", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_CHARGER_CONTROL", "1");
    expect(chargerControlStatus()).toEqual({ enabled: true, reason: "explicitly-allowed" });
  });

  it("can be forced off in production, for a read-only replica", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_CHARGER_CONTROL", "true");
    expect(chargerControlStatus()).toEqual({ enabled: false, reason: "explicitly-disabled" });
  });

  it("lets disable win over allow, so the safe setting cannot be overridden by accident", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_CHARGER_CONTROL", "1");
    vi.stubEnv("DISABLE_CHARGER_CONTROL", "1");
    expect(chargerControlStatus().enabled).toBe(false);
  });

  it("accepts the usual truthy spellings and ignores anything else", () => {
    vi.stubEnv("NODE_ENV", "development");
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      vi.stubEnv("ALLOW_CHARGER_CONTROL", v);
      expect(chargerControlStatus().enabled).toBe(true);
    }
    for (const v of ["0", "false", "", "  ", "maybe"]) {
      vi.stubEnv("ALLOW_CHARGER_CONTROL", v);
      expect(chargerControlStatus().enabled).toBe(false);
    }
  });
});

describe("syncChargerState control gate", () => {
  beforeEach(() => {
    settingsFindUnique.mockReset();
    callHaService.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not even read settings when control is disabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await syncChargerState(true);
    expect(callHaService).not.toHaveBeenCalled();
    expect(settingsFindUnique).not.toHaveBeenCalled();
  });

  it("pushes normally once production re-enables control", async () => {
    vi.stubEnv("NODE_ENV", "production");
    settingsFindUnique.mockResolvedValue({
      haChargerSwitchEntityId: "switch.zaptec_go_2_charging",
      haChargerOnService: "switch.turn_on",
    });
    planStateFindUnique.mockResolvedValue({ haSyncOn: false, haSyncAt: null });
    callHaService.mockResolvedValue(undefined);
    await syncChargerState(true);
    expect(callHaService).toHaveBeenCalledWith("switch", "turn_on", {
      entity_id: "switch.zaptec_go_2_charging",
    });
  });
});
