import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("./db", () => ({
  prisma: { settings: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

import { callHaService, getEntityState } from "./ha-client";

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
