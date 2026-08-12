import { prisma } from "./db";
import { callHaService } from "./ha-client";

const DEFAULT_ON_SERVICE = "switch.turn_on";
const DEFAULT_OFF_SERVICE = "switch.turn_off";
// Rate-limit real HA writes so rapid successive decision flips (e.g. dragging the
// target-SoC slider, which saves — and recomputes — on every step) don't bounce a
// real relay. The next recomputePlan() call (another save, or the ~10 min scheduler
// tick) retries and catches up once the cooldown has passed.
const MIN_PUSH_INTERVAL_MS = 60_000;

export type ChargerControlReason =
  | "production"
  | "explicitly-allowed"
  | "explicitly-disabled"
  | "non-production";

export interface ChargerControlStatus {
  enabled: boolean;
  reason: ChargerControlReason;
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Whether this instance is allowed to operate real hardware.
 *
 * A development copy pointed at a live Home Assistant is genuinely dangerous: the
 * charger switch would be shared with the deployment that actually owns it, and the
 * two would fight over it. Guarding the scheduler is not enough — recomputePlan()
 * runs from every settings save, timeline edit and manual refresh too, and each of
 * those ends here. So the gate lives at the single point that talks to hardware, and
 * defaults to *off* outside production: `npm run dev` never touches your charger.
 *
 * Docker and the add-on both set NODE_ENV=production and so control normally.
 * DISABLE_CHARGER_CONTROL forces off (useful for a read-only production replica);
 * ALLOW_CHARGER_CONTROL forces on, to deliberately test control from a dev copy.
 */
export function chargerControlStatus(): ChargerControlStatus {
  if (isTruthy(process.env.DISABLE_CHARGER_CONTROL)) {
    return { enabled: false, reason: "explicitly-disabled" };
  }
  if (isTruthy(process.env.ALLOW_CHARGER_CONTROL)) {
    return { enabled: true, reason: "explicitly-allowed" };
  }
  if (process.env.NODE_ENV === "production") {
    return { enabled: true, reason: "production" };
  }
  return { enabled: false, reason: "non-production" };
}

/** Parse "domain.service" notation; falls back to the given default if malformed. */
function parseService(raw: string | undefined, fallback: string): { domain: string; service: string } {
  const value = raw?.trim() || fallback;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) {
    const [domain, service] = fallback.split(".");
    return { domain, service };
  }
  return { domain: value.slice(0, dot), service: value.slice(dot + 1) };
}

/**
 * Push the charger on/off decision to Home Assistant. No-ops if not configured or
 * already in sync (avoids redundant service calls on real hardware).
 * Never throws — failures are recorded on PlanState.haSyncError and self-heal on the
 * next recomputePlan() call, since haSyncOn is only updated on success.
 */
export async function syncChargerState(chargingNow: boolean): Promise<void> {
  // Checked before anything else: a dev copy must not reach real hardware even to
  // read the settings row that would tell it which entity to switch.
  if (!chargerControlStatus().enabled) return;

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  // Simulation mode computes a plan for a fake "now" — never let that reach real
  // hardware. Only the live clock is allowed to control the actual charger.
  if (settings?.simulatedNow) return;
  const entityId = settings?.haChargerSwitchEntityId?.trim();
  if (!entityId) return;

  const plan = await prisma.planState.findUnique({ where: { id: 1 } });
  if (plan?.haSyncOn === chargingNow) return;

  if (plan?.haSyncAt && Date.now() - plan.haSyncAt.getTime() < MIN_PUSH_INTERVAL_MS) {
    return;
  }

  const { domain, service } = chargingNow
    ? parseService(settings?.haChargerOnService, DEFAULT_ON_SERVICE)
    : parseService(settings?.haChargerOffService, DEFAULT_OFF_SERVICE);

  try {
    await callHaService(domain, service, { entity_id: entityId });
    await prisma.planState.update({
      where: { id: 1 },
      data: { haSyncOn: chargingNow, haSyncAt: new Date(), haSyncError: null },
    });
  } catch (e) {
    console.error("[ha-control] charger push failed:", (e as Error).message);
    await prisma.planState
      .update({ where: { id: 1 }, data: { haSyncError: (e as Error).message } })
      .catch(() => undefined);
  }
}
