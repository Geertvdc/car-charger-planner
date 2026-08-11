import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("./db", () => ({
  prisma: { settings: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { callHaService, getEntityState, listEntityStates } from "./ha-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ha-client", () => {
  beforeEach(() => {
    findUnique.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.HA_BASE_URL;
    delete process.env.HA_ACCESS_TOKEN;
    delete process.env.SUPERVISOR_TOKEN;
  });

  describe("add-on Supervisor auth", () => {
    it("uses the Supervisor proxy and token when no explicit config is set", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "" });
      process.env.SUPERVISOR_TOKEN = "supervisor-secret";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://supervisor/core/api/states/switch.foo");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer supervisor-secret");
    });

    it("lets explicit Settings config override the Supervisor token", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "mine" });
      process.env.SUPERVISOR_TOKEN = "supervisor-secret";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://ha.local:8123/api/states/switch.foo");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer mine");
    });

    it("ignores a half-configured Settings pair and falls through to the Supervisor", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "" });
      process.env.SUPERVISOR_TOKEN = "supervisor-secret";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://supervisor/core/api/states/switch.foo");
    });
  });

  describe("listEntityStates", () => {
    it("returns an empty list when HA isn't configured", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "" });
      expect(await listEntityStates()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("maps entity ids and friendly names, sorted, filtered by domain", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse([
          { entity_id: "switch.b", state: "off", last_changed: "2026-08-07T09:00:00Z", attributes: { friendly_name: "B switch" } },
          { entity_id: "sensor.power", state: "120", last_changed: "2026-08-07T09:00:00Z", attributes: {} },
          { entity_id: "switch.a", state: "on", last_changed: "2026-08-07T10:00:00Z", attributes: { friendly_name: "A switch" } },
        ])
      );
      expect(await listEntityStates(["switch"])).toEqual([
        { entityId: "switch.a", friendlyName: "A switch", state: "on", lastChanged: "2026-08-07T10:00:00Z" },
        { entityId: "switch.b", friendlyName: "B switch", state: "off", lastChanged: "2026-08-07T09:00:00Z" },
      ]);
    });

    it("falls back to the entity id when there is no friendly name", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse([
          { entity_id: "sensor.power", state: "120", last_changed: "2026-08-07T10:00:00Z", attributes: {} },
        ])
      );
      expect(await listEntityStates()).toEqual([
        {
          entityId: "sensor.power",
          friendlyName: "sensor.power",
          state: "120",
          lastChanged: "2026-08-07T10:00:00Z",
        },
      ]);
    });

    it("swallows HA errors so the settings page still renders", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unreachable"));
      expect(await listEntityStates()).toEqual([]);
    });
  });

  describe("getEntityState", () => {
    it("returns null when HA isn't configured (no base URL/token anywhere)", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "" });
      const result = await getEntityState("switch.foo");
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("reads config from Settings and calls the states endpoint with a Bearer header", async () => {
      findUnique.mockResolvedValue({
        haBaseUrl: "http://ha.local:8123/",
        haAccessToken: "secret-token",
      });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      const result = await getEntityState("switch.zaptec_go_2");
      expect(result).toEqual({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" });
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://ha.local:8123/api/states/switch.zaptec_go_2");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    });

    it("mixes sources per field: URL from Settings, token from the environment", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "" });
      process.env.HA_ACCESS_TOKEN = "env-token";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://ha.local:8123/api/states/switch.foo");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer env-token");
    });

    it("mixes sources per field: URL from the environment, token from Settings", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "settings-token" });
      process.env.HA_BASE_URL = "http://env.local:8123";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "on", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://env.local:8123/api/states/switch.foo");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer settings-token");
    });

    it("falls back to env vars when Settings fields are empty", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "" });
      process.env.HA_BASE_URL = "http://env.local:8123";
      process.env.HA_ACCESS_TOKEN = "env-token";
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ state: "off", attributes: {}, last_changed: "2026-08-07T10:00:00Z" })
      );
      await getEntityState("switch.foo");
      const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://env.local:8123/api/states/switch.foo");
    });

    it("returns null on 404 (entity doesn't exist)", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response("not found", { status: 404 }));
      const result = await getEntityState("switch.missing");
      expect(result).toBeNull();
    });

    it("throws on other non-OK statuses", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response("boom", { status: 500 }));
      await expect(getEntityState("switch.foo")).rejects.toThrow(/500/);
    });

    it("propagates network/timeout errors", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "t" });
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));
      await expect(getEntityState("switch.foo")).rejects.toThrow("timeout");
    });
  });

  describe("callHaService", () => {
    it("throws when HA isn't configured", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "", haAccessToken: "" });
      await expect(callHaService("switch", "turn_on", { entity_id: "switch.foo" })).rejects.toThrow(
        /not configured/
      );
    });

    it("POSTs to the services endpoint with the entity payload", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "secret" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response("[]", { status: 200 }));
      await callHaService("switch", "turn_on", { entity_id: "switch.zaptec_go_2" });
      const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("http://ha.local:8123/api/services/switch/turn_on");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
      expect(JSON.parse(init.body as string)).toEqual({ entity_id: "switch.zaptec_go_2" });
    });

    it("throws on non-OK response", async () => {
      findUnique.mockResolvedValue({ haBaseUrl: "http://ha.local:8123", haAccessToken: "secret" });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response("bad", { status: 401 }));
      await expect(
        callHaService("switch", "turn_on", { entity_id: "switch.foo" })
      ).rejects.toThrow(/401/);
    });
  });
});
