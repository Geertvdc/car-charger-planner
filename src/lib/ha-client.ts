import { prisma } from "./db";

const TIMEOUT_MS = 8000;

export interface HaEntityState {
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

interface HaConfig {
  baseUrl: string;
  token: string;
}

/**
 * Outbound HA credentials (this app -> HA), distinct from Settings.haToken which
 * verifies inbound requests from HA to the legacy /api/ha/* poll routes.
 */
async function resolveHaConfig(): Promise<HaConfig | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const baseUrl = (settings?.haBaseUrl?.trim() || process.env.HA_BASE_URL?.trim() || "").replace(
    /\/+$/,
    ""
  );
  const token = (settings?.haAccessToken?.trim() || process.env.HA_ACCESS_TOKEN?.trim() || "").trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/**
 * Read one HA entity's current state. Returns null if HA isn't configured or the
 * entity doesn't exist (404) — both are "nothing to read yet", not errors. Throws
 * on unreachable/timeout/other HTTP failures so callers can distinguish and log.
 */
export async function getEntityState(entityId: string): Promise<HaEntityState | null> {
  const config = await resolveHaConfig();
  if (!config) return null;
  const res = await fetch(`${config.baseUrl}/api/states/${encodeURIComponent(entityId)}`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`HA GET /api/states/${entityId} -> ${res.status}`);
  }
  return (await res.json()) as HaEntityState;
}

/** Call a Home Assistant service (e.g. domain="switch", service="turn_on"). Throws on failure. */
export async function callHaService(
  domain: string,
  service: string,
  data: Record<string, unknown>
): Promise<void> {
  const config = await resolveHaConfig();
  if (!config) {
    throw new Error("Home Assistant is not configured (haBaseUrl/haAccessToken)");
  }
  const res = await fetch(`${config.baseUrl}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HA POST /api/services/${domain}/${service} -> ${res.status}`);
  }
}
