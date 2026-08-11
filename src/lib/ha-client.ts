import { prisma } from "./db";

const TIMEOUT_MS = 8000;

export interface HaEntityState {
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
}

export interface HaEntitySummary {
  entityId: string;
  friendlyName: string;
  state: string;
  lastChanged: string;
}

export type HaConfigSource = "settings" | "env" | "mixed" | "supervisor";

export interface HaConfig {
  baseUrl: string;
  token: string;
  source: HaConfigSource;
}

/**
 * Supervisor-proxied HA API, available only when we run as a Home Assistant add-on
 * with `homeassistant_api: true`. The Supervisor injects SUPERVISOR_TOKEN and routes
 * /core/api/* to the Core instance, so the add-on needs no long-lived token and no
 * host/port — see addon/config.yaml.
 */
const SUPERVISOR_BASE_URL = "http://supervisor/core";

/**
 * Outbound HA credentials (this app -> HA). Explicit configuration wins over the
 * ambient add-on credentials, so a standalone Docker deployment — or an add-on
 * deliberately pointed at a different HA instance — keeps control.
 *
 * The base URL and the token fall back from Settings to env *independently*. Mixing
 * is a real deployment shape (token in the compose environment, URL typed into the
 * Settings UI, or the reverse), and requiring both from the same source silently
 * disconnects it. Only when there is no usable explicit pair at all does the
 * Supervisor token apply, and then it brings its own base URL — the two are one
 * credential and can never be mixed with a user-supplied value.
 */
export async function resolveHaConfig(): Promise<HaConfig | null> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });

  const settingsBaseUrl = settings?.haBaseUrl?.trim() ?? "";
  const settingsToken = settings?.haAccessToken?.trim() ?? "";
  const envBaseUrl = process.env.HA_BASE_URL?.trim() ?? "";
  const envToken = process.env.HA_ACCESS_TOKEN?.trim() ?? "";

  const baseUrl = settingsBaseUrl || envBaseUrl;
  const token = settingsToken || envToken;
  if (baseUrl && token) {
    const urlFrom = settingsBaseUrl ? "settings" : "env";
    const tokenFrom = settingsToken ? "settings" : "env";
    return {
      baseUrl: stripTrailingSlashes(baseUrl),
      token,
      source: urlFrom === tokenFrom ? urlFrom : "mixed",
    };
  }

  const supervisorToken = process.env.SUPERVISOR_TOKEN?.trim() ?? "";
  if (supervisorToken) {
    return { baseUrl: SUPERVISOR_BASE_URL, token: supervisorToken, source: "supervisor" };
  }

  return null;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
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

export interface HaProbe {
  /** Null when nothing is configured anywhere. */
  config: HaConfig | null;
  ok: boolean;
  entities: HaEntitySummary[];
  /** Human-readable reason the probe failed, for the Settings page. */
  error?: string;
}

function toEntitySummaries(raw: unknown): HaEntitySummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const e = entry as {
        entity_id?: unknown;
        state?: unknown;
        last_changed?: unknown;
        attributes?: Record<string, unknown>;
      };
      const entityId = typeof e.entity_id === "string" ? e.entity_id : "";
      const friendly = e.attributes?.friendly_name;
      return {
        entityId,
        friendlyName: typeof friendly === "string" ? friendly : entityId,
        state: typeof e.state === "string" ? e.state : "",
        lastChanged: typeof e.last_changed === "string" ? e.last_changed : "",
      };
    })
    .filter((e) => e.entityId !== "")
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/**
 * Test the Home Assistant connection and return everything the Settings page needs to
 * explain it: which credentials were used, whether the call succeeded, why not if it
 * didn't, and the live entity list. Never throws — a broken connection has to render
 * as a diagnosis, not a crashed settings page.
 */
export async function probeHaConnection(): Promise<HaProbe> {
  const config = await resolveHaConfig();
  if (!config) return { config: null, ok: false, entities: [] };
  try {
    const res = await fetch(`${config.baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) {
      return {
        config,
        ok: false,
        entities: [],
        error: `Home Assistant rejected the access token (HTTP ${res.status}). Create a new Long-Lived Access Token and paste it below.`,
      };
    }
    if (!res.ok) {
      return { config, ok: false, entities: [], error: `Home Assistant returned HTTP ${res.status}.` };
    }
    return { config, ok: true, entities: toEntitySummaries(await res.json()) };
  } catch (e) {
    const message = (e as Error).message;
    return {
      config,
      ok: false,
      entities: [],
      error: `Could not reach ${config.baseUrl} (${message}). Check the URL is reachable from wherever this app runs — a .local hostname often isn't, from inside a container.`,
    };
  }
}

/**
 * Every entity HA currently knows about, for the Settings entity pickers. Returns an
 * empty list rather than throwing when HA isn't configured or is unreachable — the
 * pickers are suggestions, and a typed entity ID must keep working without them.
 */
export async function listEntityStates(domains?: string[]): Promise<HaEntitySummary[]> {
  const { entities } = await probeHaConnection();
  if (!domains || domains.length === 0) return entities;
  const wanted = new Set(domains);
  return entities.filter((e) => wanted.has(e.entityId.split(".")[0]));
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
