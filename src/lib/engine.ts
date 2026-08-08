import type { AvailStatus } from "./availability";

export interface EngineHour {
  hourStart: Date;
  allInPrice: number; // EUR/kWh (grid)
  solarWh: number; // forecast PV production this hour
  availability: AvailStatus;
}

export interface Deadline {
  instant: Date;
  targetSoc: number; // %
}

export interface EngineInput {
  now: Date;
  horizonEnd: Date; // next deadline instant (single-deadline convenience)
  hours: EngineHour[];
  currentSoc: number; // %
  targetSoc: number; // %
  batteryKwh: number;
  chargerPowerKw: number;
  efficiency: number; // 0..1, wall-to-battery
  houseLoadFactor: number; // fraction of forecast PV usable by the car (0..1)
  feedInTariffPerKwh: number; // opportunity cost of self-consumed solar
  maxSoc?: number; // %, cap for opportunistic cheap charging (default 100)
  cheapPriceThresholdPerKwh?: number | null; // charge below this effective cost even without target need
}

export interface MultiEngineInput {
  now: Date;
  hours: EngineHour[];
  deadlines: Deadline[]; // chronological, all after `now`
  currentSoc: number;
  batteryKwh: number;
  chargerPowerKw: number;
  efficiency: number;
  houseLoadFactor: number;
  feedInTariffPerKwh: number;
  maxSoc?: number; // %, cap for opportunistic cheap charging (default 100)
  cheapPriceThresholdPerKwh?: number | null; // charge below this effective cost even without target need
}

export interface PlanSlot {
  hourStart: Date;
  on: boolean;
  kwh: number; // energy into battery this hour
  cost: number; // EUR for this hour
  source: "grid" | "solar" | "mixed";
  effectiveCostPerKwh: number;
  reason: "target" | "cheap"; // why this hour is charging: needed for a target, or opportunistically cheap
}

export interface PlanResult {
  slots: PlanSlot[];
  feasible: boolean;
  energyNeededKwh: number; // into battery, across all deadlines
  scheduledKwh: number;
  cheapKwh: number; // portion of scheduledKwh charged opportunistically (below the cheap-price threshold, not needed for a target)
  shortfallKwh: number;
  totalCost: number;
  chargingNow: boolean;
  reason: string;
  deadlines: { instant: Date; targetSoc: number; feasible: boolean; shortfallKwh: number }[];
}

interface HourMetrics {
  hour: EngineHour;
  batteryCapKwh: number; // max into battery this hour at full power
  gridKwhFull: number;
  solarKwhFull: number;
  hourCostFull: number;
  effectiveCostPerKwh: number;
  remainingBatteryKwh: number; // decremented as we allocate across deadlines
}

function metricsFor(
  h: EngineHour,
  chargerPowerKw: number,
  efficiency: number,
  houseLoadFactor: number,
  feedInTariffPerKwh: number
): HourMetrics {
  const solarKw = Math.max(0, (h.solarWh / 1000) * houseLoadFactor);
  const gridKw = Math.max(0, chargerPowerKw - solarKw);
  const gridKwhFull = gridKw;
  const solarKwhFull = Math.min(solarKw, chargerPowerKw);
  const batteryCapKwh = chargerPowerKw * efficiency;
  const hourCostFull = gridKwhFull * h.allInPrice + solarKwhFull * feedInTariffPerKwh;
  const effectiveCostPerKwh = batteryCapKwh > 0 ? hourCostFull / batteryCapKwh : Infinity;
  return {
    hour: h,
    batteryCapKwh,
    gridKwhFull,
    solarKwhFull,
    hourCostFull,
    effectiveCostPerKwh,
    remainingBatteryKwh: batteryCapKwh,
  };
}

/**
 * Cost- and solar-aware scheduler across multiple deadlines.
 * Deadlines are satisfied in chronological order; each uses the cheapest still-available
 * home hours in the whole span from now to that deadline (so a cheap afternoon the day
 * before is used ahead of an expensive night). Charge banked for an earlier deadline
 * counts toward later ones (no driving between deadlines is modelled — correct current
 * SoC via the dashboard).
 */
export function computeMultiPlan(input: MultiEngineInput): PlanResult {
  const {
    now,
    hours,
    deadlines,
    currentSoc,
    batteryKwh,
    chargerPowerKw,
    efficiency,
    houseLoadFactor,
    feedInTariffPerKwh,
    maxSoc = 100,
    cheapPriceThresholdPerKwh = null,
  } = input;

  const nowHour = new Date(now);
  nowHour.setUTCMinutes(0, 0, 0);

  const metrics = new Map<number, HourMetrics>();
  for (const h of hours) {
    if (h.availability === "AWAY") continue;
    if (h.hourStart < nowHour) continue;
    metrics.set(
      h.hourStart.getTime(),
      metricsFor(h, chargerPowerKw, efficiency, houseLoadFactor, feedInTariffPerKwh)
    );
  }

  // `metrics` already excludes AWAY hours (see above), so every candidate here is
  // home — rank purely by effective cost.
  const rank = (m: HourMetrics) => m.effectiveCostPerKwh;

  const sortedDeadlines = [...deadlines].sort((a, b) => a.instant.getTime() - b.instant.getTime());

  let projectedBatteryKwh = (currentSoc / 100) * batteryKwh;
  let energyNeededTotal = 0;
  const perDeadline: PlanResult["deadlines"] = [];

  for (const d of sortedDeadlines) {
    const targetKwh = (d.targetSoc / 100) * batteryKwh;
    let need = Math.max(0, targetKwh - projectedBatteryKwh);
    energyNeededTotal += need;
    if (need <= 1e-6) {
      perDeadline.push({ instant: d.instant, targetSoc: d.targetSoc, feasible: true, shortfallKwh: 0 });
      continue;
    }
    const candidates = [...metrics.values()]
      .filter((m) => m.remainingBatteryKwh > 1e-6 && m.hour.hourStart < d.instant)
      .sort((a, b) => rank(a) - rank(b));

    for (const m of candidates) {
      if (need <= 1e-6) break;
      const take = Math.min(m.remainingBatteryKwh, need);
      m.remainingBatteryKwh -= take;
      projectedBatteryKwh += take;
      need -= take;
    }
    perDeadline.push({
      instant: d.instant,
      targetSoc: d.targetSoc,
      feasible: need <= 1e-6,
      shortfallKwh: Math.max(0, need),
    });
  }

  // kWh already allocated per hour for target need, before any opportunistic top-up.
  const targetUsedByHour = new Map<number, number>();
  for (const [t, m] of metrics) targetUsedByHour.set(t, m.batteryCapKwh - m.remainingBatteryKwh);

  // Opportunistic cheap-price charging: fill remaining headroom (up to maxSoc) with any
  // hour whose effective cost/kWh is at or below the threshold, even without target need.
  if (cheapPriceThresholdPerKwh != null) {
    const capKwh = (Math.max(0, Math.min(100, maxSoc)) / 100) * batteryKwh;
    let headroom = Math.max(0, capKwh - projectedBatteryKwh);
    if (headroom > 1e-6) {
      const cheapCandidates = [...metrics.values()]
        .filter((m) => m.remainingBatteryKwh > 1e-6 && m.effectiveCostPerKwh <= cheapPriceThresholdPerKwh)
        .sort((a, b) => rank(a) - rank(b));
      for (const m of cheapCandidates) {
        if (headroom <= 1e-6) break;
        const take = Math.min(m.remainingBatteryKwh, headroom);
        m.remainingBatteryKwh -= take;
        projectedBatteryKwh += take;
        headroom -= take;
      }
    }
  }

  // Build chronological slots from what was allocated (batteryCap - remaining).
  let scheduledKwh = 0;
  let cheapKwh = 0;
  let totalCost = 0;
  const slots: PlanSlot[] = [...metrics.values()]
    .sort((a, b) => a.hour.hourStart.getTime() - b.hour.hourStart.getTime())
    .map((m) => {
      const used = m.batteryCapKwh - m.remainingBatteryKwh;
      const on = used > 1e-6;
      const fraction = m.batteryCapKwh > 0 ? used / m.batteryCapKwh : 0;
      const cost = m.hourCostFull * fraction;
      const targetUsed = targetUsedByHour.get(m.hour.hourStart.getTime()) ?? 0;
      const cheapUsed = Math.max(0, used - targetUsed);
      if (on) {
        scheduledKwh += used;
        totalCost += cost;
        if (targetUsed <= 1e-6) cheapKwh += cheapUsed;
      }
      const source: PlanSlot["source"] =
        m.solarKwhFull <= 1e-6 ? "grid" : m.gridKwhFull <= 1e-6 ? "solar" : "mixed";
      // Only label a slot "cheap" when none of it is actually needed for a target —
      // a hour that's already required stays labelled "target" even if some slack
      // capacity in it also happens to clear the threshold.
      const reason: PlanSlot["reason"] = targetUsed <= 1e-6 && cheapUsed > 1e-6 ? "cheap" : "target";
      return {
        hourStart: m.hour.hourStart,
        on,
        kwh: used,
        cost,
        source,
        effectiveCostPerKwh: m.effectiveCostPerKwh,
        reason,
      };
    });

  const onSet = new Set(slots.filter((s) => s.on).map((s) => s.hourStart.getTime()));
  const chargingNow = onSet.has(nowHour.getTime());

  const shortfallKwh = perDeadline.reduce((a, d) => a + d.shortfallKwh, 0);
  const feasible = shortfallKwh <= 1e-6;
  const next = sortedDeadlines[0];

  let reason: string;
  if (energyNeededTotal <= 1e-6 && cheapKwh <= 1e-6) {
    reason = "Already at/above every upcoming target.";
  } else if (feasible) {
    reason = `Charging ${scheduledKwh.toFixed(1)} kWh across ${onSet.size} h for ~€${totalCost.toFixed(
      2
    )} to meet ${sortedDeadlines.length} deadline${sortedDeadlines.length > 1 ? "s" : ""}.`;
    if (cheapKwh > 1e-6) {
      reason += ` +${cheapKwh.toFixed(1)} kWh opportunistic (below €${cheapPriceThresholdPerKwh?.toFixed(3)}/kWh).`;
    }
  } else {
    reason = `Not enough home hours: short ${shortfallKwh.toFixed(
      1
    )} kWh. Widen a home window or lower a target.`;
  }

  return {
    slots,
    feasible,
    energyNeededKwh: energyNeededTotal,
    scheduledKwh,
    cheapKwh,
    shortfallKwh,
    totalCost,
    chargingNow,
    reason,
    deadlines: perDeadline,
    // keep next-deadline target handy for callers
    ...(next ? {} : {}),
  };
}

/** Single-deadline convenience wrapper (used by unit tests and simple callers). */
export function computePlan(input: EngineInput): PlanResult {
  return computeMultiPlan({
    now: input.now,
    hours: input.hours,
    deadlines: [{ instant: input.horizonEnd, targetSoc: input.targetSoc }],
    currentSoc: input.currentSoc,
    batteryKwh: input.batteryKwh,
    chargerPowerKw: input.chargerPowerKw,
    efficiency: input.efficiency,
    houseLoadFactor: input.houseLoadFactor,
    feedInTariffPerKwh: input.feedInTariffPerKwh,
    maxSoc: input.maxSoc,
    cheapPriceThresholdPerKwh: input.cheapPriceThresholdPerKwh,
  });
}
