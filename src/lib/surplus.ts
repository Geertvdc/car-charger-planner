/**
 * Solar-surplus charging: the live, closed-loop half of the planner.
 *
 * The engine (engine.ts) plans ahead from a PV *forecast*. This module decides what the
 * charger should be doing *right now* from the *measured* grid reading, so any power the
 * house would otherwise export goes into the car instead. Exporting is worth much less
 * than self-consuming (the energy tax is never refunded — see pricing.ts), so every kWh
 * diverted here is worth roughly the import/export spread.
 *
 * Pure, like engine.ts: no DB, no HA, no clock. controller.ts does the wiring.
 */

export type ChargeMode = "off" | "plan" | "surplus";

/** One aligned measurement. Both figures must come from the same instant. */
export interface PowerSample {
  at: Date;
  /** Grid meter. POSITIVE = importing from the grid, negative = exporting. */
  gridWatts: number;
  /** What the charger is drawing right now. */
  chargerWatts: number;
}

export interface SurplusInput {
  now: Date;
  /** Trailing window of samples, any order. Empty means "can't measure right now". */
  samples: PowerSample[];
  enabled: boolean;
  connected: boolean;
  soc: number;
  maxSoc: number;
  /**
   * Whether the *plan* wants the charger on at full power for this slot. Only true for
   * target/cheap slots — a slot the engine labelled "surplus" is a forecast, and the
   * live measurement below overrules it.
   */
  planOn: boolean;
  planAmps: number;
  phases: number;
  voltage: number;
  minCurrentA: number;
  maxCurrentA: number;
  /** Export to leave untouched, as a buffer against overshooting into import. */
  reserveWatts: number;
  startDelayMs: number;
  stopDelayMs: number;
  /** Hysteresis state carried across ticks. */
  surplusSinceAt: Date | null;
  deficitSinceAt: Date | null;
  /** What the charger is currently doing, so the loop has somewhere to start from. */
  currentMode: ChargeMode;
  currentAmps: number;
}

export interface ChargeCommand {
  on: boolean;
  amps: number;
  mode: ChargeMode;
  reason: string;
  /** Household surplus the decision was made on, in watts. Null when unmeasurable. */
  availableWatts: number | null;
  surplusSinceAt: Date | null;
  deficitSinceAt: Date | null;
}

/**
 * Median, not mean. The control loop only gets to move the charger once every 5 minutes,
 * so a single sample landing while the oven or the kettle is on would otherwise drag the
 * current down for the whole interval. A median over the trailing window rides through
 * short spikes and only follows a load change that actually persists.
 */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function resolveChargeCommand(input: SurplusInput): ChargeCommand {
  const {
    now,
    samples,
    enabled,
    connected,
    soc,
    maxSoc,
    planOn,
    planAmps,
    phases,
    voltage,
    minCurrentA,
    maxCurrentA,
    reserveWatts,
    startDelayMs,
    stopDelayMs,
    currentMode,
    currentAmps,
  } = input;

  const clamp = (a: number) => Math.max(minCurrentA, Math.min(maxCurrentA, Math.round(a)));

  // The grid meter already includes the car, so add the car back out to get what the
  // *rest* of the house is doing. Negative grid + whatever the car is taking = the power
  // that is available to the car, whether it is using it yet or not.
  const measurable = samples.length > 0;
  const availableWatts = measurable
    ? median(samples.map((s) => s.chargerWatts - s.gridWatts)) - reserveWatts
    : null;
  // Round down: overshooting pulls from the grid, undershooting just exports a little.
  const targetAmps = availableWatts == null ? 0 : Math.floor(availableWatts / (phases * voltage));

  // Track how long surplus has been sufficient / insufficient, regardless of which branch
  // wins below, so the timers stay truthful while the plan is in charge and a handover
  // can happen the moment the plan slot ends.
  let surplusSinceAt = input.surplusSinceAt;
  let deficitSinceAt = input.deficitSinceAt;
  if (measurable) {
    if (targetAmps >= minCurrentA) {
      surplusSinceAt = surplusSinceAt ?? now;
      deficitSinceAt = null;
    } else {
      deficitSinceAt = deficitSinceAt ?? now;
      surplusSinceAt = null;
    }
  }

  const held = (since: Date | null, ms: number) =>
    since != null && now.getTime() - since.getTime() >= ms;

  const done = (
    on: boolean,
    amps: number,
    mode: ChargeMode,
    reason: string
  ): ChargeCommand => ({ on, amps, mode, reason, availableWatts, surplusSinceAt, deficitSinceAt });

  const off = (reason: string) => done(false, minCurrentA, "off", reason);

  // 1. A deadline beats the sun. Run at full power and let the grid cover whatever PV
  //    doesn't — the plan already decided this slot is worth paying for. Still requires a
  //    car to be plugged in: otherwise the log/telemetry would show charging that never
  //    physically happened.
  if (planOn) {
    if (!connected) return off("Plan wants to charge, but no car connected.");
    return done(true, clamp(planAmps), "plan", "Charging to meet the plan's target.");
  }

  if (!enabled) return off("Solar surplus charging is off.");
  if (!connected) return off("No car connected.");
  if (soc >= maxSoc) return off(`Battery at ${soc}%, at or above the ${maxSoc}% cap.`);

  // 2. No usable measurement. Hold whatever a surplus session was already doing rather
  //    than cutting it off on a momentary sensor gap; start nothing new.
  if (!measurable) {
    if (currentMode === "surplus") {
      return done(true, clamp(currentAmps), "surplus", "Holding — no power reading right now.");
    }
    return off("No power reading available.");
  }

  const kw = ((targetAmps * phases * voltage) / 1000).toFixed(1);

  // 3. Enough surplus. An already-running session follows it immediately; a new one waits
  //    for the surplus to hold, so a passing cloud gap doesn't start a session.
  if (targetAmps >= minCurrentA) {
    if (currentMode === "surplus" || held(surplusSinceAt, startDelayMs)) {
      return done(true, clamp(targetAmps), "surplus", `Following ${kw} kW of solar surplus.`);
    }
    return off("Surplus available — waiting for it to hold.");
  }

  // 4. Not enough surplus. Hold a running session at the minimum for a while: importing a
  //    few hundred watts briefly is better than tearing the session down and restarting
  //    it the moment the next cloud passes.
  if (currentMode === "surplus" && !held(deficitSinceAt, stopDelayMs)) {
    return done(true, minCurrentA, "surplus", "Surplus dipped — holding at the minimum.");
  }

  const shortfall = availableWatts == null ? 0 : Math.round(minCurrentA * phases * voltage - availableWatts);
  return off(`Not enough surplus (${shortfall} W short of the ${minCurrentA} A minimum).`);
}
