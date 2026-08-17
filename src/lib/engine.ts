import type { AvailStatus } from "./availability";
import { floorToSlot } from "./time";

export interface EngineHour {
  hourStart: Date;
  allInPrice: number; // EUR/kWh paid when importing this slot
  // EUR/kWh received when exporting this slot. Always below allInPrice — the energy tax
  // is never refunded on export — and can be negative when the market price is. That gap
  // is what makes charging from surplus PV cheaper than any grid hour. See pricing.ts.
  feedInPrice: number;
  solarWh: number; // forecast PV production this hour
  availability: AvailStatus;
}

export interface Deadline {
  instant: Date;
  targetSoc: number; // %
}

/** The charger's electrical envelope. Defaults match a 3-phase 230 V 16 A wallbox. */
export interface ChargerLimits {
  phases?: number; // default 3
  voltage?: number; // default 230
  minCurrentA?: number; // default 6 — the IEC 61851 floor; below it the car won't draw
  maxCurrentA?: number; // default 16
}

export interface EngineInput extends ChargerLimits {
  now: Date;
  horizonEnd: Date; // next deadline instant (single-deadline convenience)
  hours: EngineHour[];
  currentSoc: number; // %
  targetSoc: number; // %
  batteryKwh: number;
  chargerPowerKw: number;
  efficiency: number; // 0..1, wall-to-battery
  houseLoadFactor: number; // fraction of forecast PV usable by the car (0..1)
  maxSoc?: number; // %, cap for opportunistic cheap charging (default 100)
  cheapPriceThresholdPerKwh?: number | null; // charge below this effective cost even without target need
  slotHours?: number; // duration of each `hours` bucket, in hours (default 1)
}

export interface MultiEngineInput extends ChargerLimits {
  now: Date;
  hours: EngineHour[];
  deadlines: Deadline[]; // chronological, all after `now`
  currentSoc: number;
  batteryKwh: number;
  chargerPowerKw: number;
  efficiency: number;
  houseLoadFactor: number;
  maxSoc?: number; // %, cap for opportunistic cheap charging (default 100)
  cheapPriceThresholdPerKwh?: number | null; // charge below this effective cost even without target need
  slotHours?: number; // duration of each `hours` bucket, in hours (default 1)
}

export type PlanReason = "target" | "cheap" | "surplus";

export interface PlanSlot {
  hourStart: Date;
  on: boolean;
  kwh: number; // energy into battery this hour
  cost: number; // EUR for this hour
  source: "grid" | "solar" | "mixed";
  effectiveCostPerKwh: number;
  /**
   * target  — needed to reach a deadline's SoC.
   * cheap   — opportunistic, effective cost is below cheapPriceThresholdPerKwh.
   * surplus — forecast PV covers the charge, so it displaces export rather than import.
   */
  reason: PlanReason;
  /** Charger current this slot is planned at: full power except for surplus slots. */
  amps: number;
}

export interface PlanResult {
  slots: PlanSlot[];
  feasible: boolean;
  energyNeededKwh: number; // into battery, across all deadlines
  scheduledKwh: number;
  cheapKwh: number; // portion of scheduledKwh charged opportunistically (below the cheap-price threshold, not needed for a target)
  surplusKwh: number; // portion charged from forecast PV surplus instead of exporting it
  shortfallKwh: number;
  totalCost: number;
  chargingNow: boolean;
  reason: string;
  deadlines: { instant: Date; targetSoc: number; feasible: boolean; shortfallKwh: number }[];
}

interface HourMetrics {
  hour: EngineHour;
  solarAvgKw: number; // forecast PV available to the car this slot
  batteryCapKwh: number; // max into battery this hour at full power
  solarCapKwh: number; // max into battery this hour on PV alone
  gridKwhFull: number;
  solarKwhFull: number;
  hourCostFull: number;
  effectiveCostPerKwh: number;
  surplusCostPerKwh: number; // EUR per battery-kWh when running on PV alone
  remainingBatteryKwh: number; // decremented as we allocate across deadlines
}

interface SlotConfig {
  chargerPowerKw: number;
  efficiency: number;
  houseLoadFactor: number;
}

function metricsFor(h: EngineHour, cfg: SlotConfig, slotHours: number): HourMetrics {
  // h.solarWh is the energy forecast for this bucket; divide by its duration to get an
  // average kW so the comparison against chargerPowerKw (also kW) holds at any slot size.
  const solarAvgKw = Math.max(0, (h.solarWh / 1000 / slotHours) * cfg.houseLoadFactor);
  const gridKw = Math.max(0, cfg.chargerPowerKw - solarAvgKw);
  const gridKwhFull = gridKw * slotHours;
  const solarKwhFull = Math.min(solarAvgKw, cfg.chargerPowerKw) * slotHours;
  const batteryCapKwh = cfg.chargerPowerKw * cfg.efficiency * slotHours;
  const solarCapKwh = solarKwhFull * cfg.efficiency;
  // Running at full power: the PV share costs the feed-in revenue you gave up, the rest
  // is bought from the grid.
  const hourCostFull = gridKwhFull * h.allInPrice + solarKwhFull * h.feedInPrice;
  const effectiveCostPerKwh = batteryCapKwh > 0 ? hourCostFull / batteryCapKwh : Infinity;
  // Running on PV alone: no grid component at all, so the only cost is the forgone
  // export. Since feedInPrice is always below allInPrice, this is always the cheapest
  // energy available in any slot — which is why the surplus pass runs before the
  // opportunistic cheap pass.
  const surplusCostPerKwh = solarCapKwh > 0 ? (solarKwhFull * h.feedInPrice) / solarCapKwh : Infinity;
  return {
    hour: h,
    solarAvgKw,
    batteryCapKwh,
    solarCapKwh,
    gridKwhFull,
    solarKwhFull,
    hourCostFull,
    effectiveCostPerKwh,
    surplusCostPerKwh,
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
    maxSoc = 100,
    cheapPriceThresholdPerKwh = null,
    slotHours = 1,
    phases = 3,
    voltage = 230,
    minCurrentA = 6,
    maxCurrentA = 16,
  } = input;

  const nowHour = floorToSlot(now);
  // Smallest charge the wallbox can actually deliver. On 3 phases at 6 A that is ~4.1 kW,
  // so a slot whose forecast PV falls short of it is no use for surplus charging: the car
  // would simply refuse to draw.
  const minChargeKw = (minCurrentA * phases * voltage) / 1000;
  const ampsFor = (kw: number) =>
    Math.max(minCurrentA, Math.min(maxCurrentA, Math.round((kw * 1000) / (phases * voltage))));

  const metrics = new Map<number, HourMetrics>();
  for (const h of hours) {
    if (h.availability === "AWAY") continue;
    if (h.hourStart < nowHour) continue;
    metrics.set(
      h.hourStart.getTime(),
      metricsFor(h, { chargerPowerKw, efficiency, houseLoadFactor }, slotHours)
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

  // Headroom shared by the two opportunistic passes below.
  const capKwh = (Math.max(0, Math.min(100, maxSoc)) / 100) * batteryKwh;
  let headroom = Math.max(0, capKwh - projectedBatteryKwh);

  /**
   * Surplus pass — the point of the whole feature. A slot whose forecast PV on its own
   * meets the charger's minimum is one where the house would otherwise be exporting;
   * charging there costs only the forgone feed-in revenue instead of a full grid price.
   *
   * Runs before the cheap pass because surplus energy is unconditionally cheaper than
   * any grid hour (feedInPrice < allInPrice always — the energy tax is never refunded),
   * and it is not gated on cheapPriceThresholdPerKwh: it is worth doing whether or not
   * the user has opted into opportunistic cheap charging at all.
   *
   * Only slots the target pass left completely untouched are candidates. A slot already
   * charging at full power for a deadline is *already* self-consuming all of its PV —
   * there is no additional surplus there to capture.
   */
  const surplusUsedByHour = new Map<number, number>();
  if (headroom > 1e-6) {
    const surplusCandidates = [...metrics.values()]
      .filter(
        (m) =>
          (targetUsedByHour.get(m.hour.hourStart.getTime()) ?? 0) <= 1e-6 &&
          m.solarAvgKw >= minChargeKw &&
          m.solarCapKwh > 1e-6
      )
      .sort((a, b) => a.surplusCostPerKwh - b.surplusCostPerKwh);
    for (const m of surplusCandidates) {
      if (headroom <= 1e-6) break;
      const take = Math.min(m.solarCapKwh, headroom);
      if (take <= 1e-6) continue;
      m.remainingBatteryKwh -= take;
      projectedBatteryKwh += take;
      headroom -= take;
      surplusUsedByHour.set(m.hour.hourStart.getTime(), take);
    }
  }

  // Opportunistic cheap-price charging: fill remaining headroom (up to maxSoc) with any
  // hour whose effective cost/kWh is at or below the threshold, even without target need.
  // Skips slots the surplus pass claimed — those are costed on PV alone, and topping them
  // up from the grid would blend two cost models in one slot for no real gain.
  if (cheapPriceThresholdPerKwh != null && headroom > 1e-6) {
    const cheapCandidates = [...metrics.values()]
      .filter(
        (m) =>
          m.remainingBatteryKwh > 1e-6 &&
          !surplusUsedByHour.has(m.hour.hourStart.getTime()) &&
          m.effectiveCostPerKwh <= cheapPriceThresholdPerKwh
      )
      .sort((a, b) => rank(a) - rank(b));
    for (const m of cheapCandidates) {
      if (headroom <= 1e-6) break;
      const take = Math.min(m.remainingBatteryKwh, headroom);
      m.remainingBatteryKwh -= take;
      projectedBatteryKwh += take;
      headroom -= take;
    }
  }

  // Build chronological slots from what was allocated (batteryCap - remaining).
  let scheduledKwh = 0;
  let cheapKwh = 0;
  let surplusKwh = 0;
  let totalCost = 0;
  const slots: PlanSlot[] = [...metrics.values()]
    .sort((a, b) => a.hour.hourStart.getTime() - b.hour.hourStart.getTime())
    .map((m) => {
      const key = m.hour.hourStart.getTime();
      const used = m.batteryCapKwh - m.remainingBatteryKwh;
      const on = used > 1e-6;
      const targetUsed = targetUsedByHour.get(key) ?? 0;
      const surplusUsed = surplusUsedByHour.get(key) ?? 0;
      const cheapUsed = Math.max(0, used - targetUsed - surplusUsed);

      // A surplus slot never mixes with the other passes (see the filters above), so it
      // is costed purely on PV and runs at whatever current the sun can carry.
      const isSurplus = surplusUsed > 1e-6;
      const cost = isSurplus
        ? surplusUsed * m.surplusCostPerKwh
        : m.hourCostFull * (m.batteryCapKwh > 0 ? used / m.batteryCapKwh : 0);
      const effectiveCostPerKwh = isSurplus ? m.surplusCostPerKwh : m.effectiveCostPerKwh;
      const amps = isSurplus
        ? ampsFor(Math.min(m.solarAvgKw, chargerPowerKw))
        : maxCurrentA;

      if (on) {
        scheduledKwh += used;
        totalCost += cost;
        if (isSurplus) surplusKwh += surplusUsed;
        else if (targetUsed <= 1e-6) cheapKwh += cheapUsed;
      }
      const source: PlanSlot["source"] = isSurplus
        ? "solar"
        : m.solarKwhFull <= 1e-6
          ? "grid"
          : m.gridKwhFull <= 1e-6
            ? "solar"
            : "mixed";
      // Only label a slot "cheap" when none of it is actually needed for a target —
      // a hour that's already required stays labelled "target" even if some slack
      // capacity in it also happens to clear the threshold.
      const reason: PlanReason = isSurplus
        ? "surplus"
        : targetUsed <= 1e-6 && cheapUsed > 1e-6
          ? "cheap"
          : "target";
      return {
        hourStart: m.hour.hourStart,
        on,
        kwh: used,
        cost,
        source,
        effectiveCostPerKwh,
        reason,
        amps,
      };
    });

  const onSet = new Set(slots.filter((s) => s.on).map((s) => s.hourStart.getTime()));
  const chargingNow = onSet.has(nowHour.getTime());

  const shortfallKwh = perDeadline.reduce((a, d) => a + d.shortfallKwh, 0);
  const feasible = shortfallKwh <= 1e-6;
  const next = sortedDeadlines[0];

  let reason: string;
  if (energyNeededTotal <= 1e-6 && cheapKwh <= 1e-6 && surplusKwh <= 1e-6) {
    reason = "Already at/above every upcoming target.";
  } else if (feasible) {
    reason = `Charging ${scheduledKwh.toFixed(1)} kWh across ${(onSet.size * slotHours).toFixed(
      2
    )} h for ~€${totalCost.toFixed(2)} to meet ${sortedDeadlines.length} deadline${
      sortedDeadlines.length > 1 ? "s" : ""
    }.`;
    if (surplusKwh > 1e-6) {
      reason += ` +${surplusKwh.toFixed(1)} kWh from solar surplus instead of exporting it.`;
    }
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
    surplusKwh,
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
    maxSoc: input.maxSoc,
    cheapPriceThresholdPerKwh: input.cheapPriceThresholdPerKwh,
    slotHours: input.slotHours,
    phases: input.phases,
    voltage: input.voltage,
    minCurrentA: input.minCurrentA,
    maxCurrentA: input.maxCurrentA,
  });
}
