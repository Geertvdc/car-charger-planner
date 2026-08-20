import { prisma } from "./db";
import { callHaService } from "./ha-client";
import type { ChargeCommand } from "./surplus";

const DEFAULT_ON_SERVICE = "switch.turn_on";
const DEFAULT_OFF_SERVICE = "switch.turn_off";
const DEFAULT_CURRENT_SERVICE = "number.set_value";
const DEFAULT_CURRENT_VALUE_KEY = "value";
// Rate-limit real HA writes so rapid successive decision flips (e.g. dragging the
// target-SoC slider, which saves — and recomputes — on every step) don't bounce a
// real relay. The next recomputePlan() call (another save, or the ~10 min scheduler
// tick) retries and catches up once the cooldown has passed.
const MIN_PUSH_INTERVAL_MS = 60_000;
/**
 * Current changes are throttled far harder than on/off. The surplus controller runs every
 * 30 s, but a charger's current limit goes through the vendor's cloud (Zaptec's, here),
 * which throttles callers that hammer it — and the physical charger renegotiates with the
 * car on every change. One push per 5 minutes is the deliberate ceiling.
 */
const MIN_AMPS_PUSH_INTERVAL_MS = 5 * 60 * 1000;
/** Don't spend a push on a change the charger's 1 A step can't even represent. */
const AMPS_DEADBAND = 1;

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
 * Push a charge command to Home Assistant — the single point in the app that operates
 * real hardware. On/off and current are pushed independently, on their own cooldowns.
 *
 * No-ops if not configured or already in sync (avoids redundant service calls on real
 * hardware). Never throws — failures are recorded on PlanState.haSyncError and self-heal
 * on the next tick, since haSyncOn/ampsSyncValue are only updated on success.
 */
export async function applyChargeCommand(cmd: ChargeCommand): Promise<void> {
  // Checked before anything else: a dev copy must not reach real hardware even to
  // read the settings row that would tell it which entity to switch.
  if (!chargerControlStatus().enabled) return;

  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  // Simulation mode computes a plan for a fake "now" — never let that reach real
  // hardware. Only the live clock is allowed to control the actual charger.
  if (settings?.simulatedNow) return;

  // Nothing to drive at all — don't even read the plan row.
  const hasSwitch = !!settings?.haChargerSwitchEntityId?.trim();
  const hasCurrent = !!settings?.haChargerCurrentEntityId?.trim();
  if (!hasSwitch && !hasCurrent) return;

  const plan = await prisma.planState.findUnique({ where: { id: 1 } });

  // Current first: raising the limit before starting means the session negotiates at the
  // right current straight away instead of at whatever it was left at.
  await pushCurrent(cmd, settings, plan);
  await pushOnOff(cmd.on, settings, plan);
}

/** Back-compat wrapper for callers that only care about on/off. */
export async function syncChargerState(chargingNow: boolean): Promise<void> {
  await applyChargeCommand({
    on: chargingNow,
    amps: 0,
    mode: chargingNow ? "plan" : "off",
    reason: "",
    availableWatts: null,
    surplusSinceAt: null,
    deficitSinceAt: null,
  });
}

type SettingsRow = Awaited<ReturnType<typeof prisma.settings.findUnique>>;
type PlanRow = Awaited<ReturnType<typeof prisma.planState.findUnique>>;

async function pushOnOff(on: boolean, settings: SettingsRow, plan: PlanRow): Promise<void> {
  const entityId = settings?.haChargerSwitchEntityId?.trim();
  if (!entityId) return;
  // haSyncOn only records the state we last *commanded* — it doesn't notice the charger
  // resuming a session on its own (a connectivity blip reconnecting mid-charge, a vendor
  // app override, the car's own resume-on-plug-in behaviour). When we want the charger
  // off but the connected-entity sensor says it's actively charging anyway, the cache is
  // stale: force the push through instead of trusting it.
  const staleOff = on === false && plan?.chargerReportedCharging === true;
  if (plan?.haSyncOn === on && !staleOff) return;
  if (plan?.haSyncAt && Date.now() - plan.haSyncAt.getTime() < MIN_PUSH_INTERVAL_MS) return;

  const { domain, service } = on
    ? parseService(settings?.haChargerOnService, DEFAULT_ON_SERVICE)
    : parseService(settings?.haChargerOffService, DEFAULT_OFF_SERVICE);

  try {
    await callHaService(domain, service, { entity_id: entityId });
    await prisma.planState.update({
      where: { id: 1 },
      data: { haSyncOn: on, haSyncAt: new Date(), haSyncError: null },
    });
  } catch (e) {
    console.error("[ha-control] charger push failed:", (e as Error).message);
    await prisma.planState
      .update({ where: { id: 1 }, data: { haSyncError: (e as Error).message } })
      .catch(() => undefined);
  }
}

async function pushCurrent(cmd: ChargeCommand, settings: SettingsRow, plan: PlanRow): Promise<void> {
  const entityId = settings?.haChargerCurrentEntityId?.trim();
  if (!entityId) return;
  // Nothing to set while the charger is off; the next start will set it.
  if (!cmd.on || !Number.isFinite(cmd.amps) || cmd.amps <= 0) return;

  const amps = Math.round(cmd.amps);
  const last = plan?.ampsSyncValue ?? null;
  if (last != null && Math.abs(amps - last) < AMPS_DEADBAND) return;

  // A handover to plan mode raises to full power and must not wait out a cooldown that a
  // surplus push started seconds earlier — a deadline slot stuck at 6 A for five minutes
  // is exactly the failure this whole throttle is not meant to cause.
  const isPlanRamp = cmd.mode === "plan" && (last == null || amps > last);
  const cooling =
    plan?.ampsSyncAt != null && Date.now() - plan.ampsSyncAt.getTime() < MIN_AMPS_PUSH_INTERVAL_MS;
  if (cooling && !isPlanRamp) return;

  const { domain, service } = parseService(settings?.haChargerCurrentService, DEFAULT_CURRENT_SERVICE);
  const valueKey = settings?.haChargerCurrentValueKey?.trim() || DEFAULT_CURRENT_VALUE_KEY;

  try {
    await callHaService(domain, service, { entity_id: entityId, [valueKey]: amps });
    await prisma.planState.update({
      where: { id: 1 },
      data: { ampsSyncValue: amps, ampsSyncAt: new Date(), haSyncError: null },
    });
  } catch (e) {
    console.error("[ha-control] current push failed:", (e as Error).message);
    await prisma.planState
      .update({ where: { id: 1 }, data: { haSyncError: (e as Error).message } })
      .catch(() => undefined);
  }
}
