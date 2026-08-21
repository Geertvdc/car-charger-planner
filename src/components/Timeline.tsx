"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailStatus } from "@/lib/availability";
import type { TimelineData, TimelineDay, TimelineHour } from "@/lib/timeline";
import { useAppUrl } from "./BasePathProvider";

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60_000;
const COL = 10; // px per 15-min slot (an hour spans 4 columns)
const PAD_X = 10;
const PRICE_TOP = 12;
const PRICE_H = 140;
const PRICE_BOTTOM = PRICE_TOP + PRICE_H;
const AVAIL_Y = PRICE_BOTTOM + 10;
const AVAIL_H = 14;
const CHARGE_Y = AVAIL_Y + AVAIL_H + 4;
const CHARGE_H = 11;
const LABEL_Y = CHARGE_Y + CHARGE_H + 16;
const SVG_H = LABEL_Y + 6;

// Map a morning-target SOC (0..100%) onto the price-chart band: 100% at the top,
// 0% at the baseline. The target line/handle share this band with the price bars.
const socY = (soc: number) => PRICE_BOTTOM - (Math.max(0, Math.min(100, soc)) / 100) * PRICE_H;
const socFromY = (y: number) => Math.round((((PRICE_BOTTOM - y) / PRICE_H) * 100) / 5) * 5;

// Cycle a home/away state on tap: away → home → away.
const NEXT_STATUS: Record<AvailStatus, AvailStatus> = {
  AWAY: "HOME",
  HOME: "AWAY",
};

function priceRatio(price: number, maxPrice: number): number {
  return price / maxPrice;
}

function barFill(ratio: number): string {
  if (ratio < 0.4) return "url(#gradCheap)";
  if (ratio < 0.66) return "url(#gradMid)";
  return "url(#gradExpensive)";
}

// Why a slot is charging, and how that reads on the chart.
// surplus is the one to spot at a glance: it's the free energy that would otherwise have
// been exported at a much worse price.
const CHARGE_STYLE: Record<string, { color: string; glow: string; label: string }> = {
  target: { color: "var(--color-charge)", glow: "rgba(255,201,77,0.6)", label: "target" },
  cheap: { color: "var(--color-charge-cheap)", glow: "rgba(46,158,110,0.6)", label: "cheap" },
  surplus: {
    color: "var(--color-charge-surplus)",
    glow: "rgba(53,208,196,0.65)",
    label: "solar surplus",
  },
};
const chargeStyle = (reason: string | null) => CHARGE_STYLE[reason ?? "target"] ?? CHARGE_STYLE.target;

function availFill(status: AvailStatus, forced: boolean): string {
  // Amber: home only because the charger's plugged in right now, not per the schedule
  // (see TimelineHour.forcedHome / applyChargerConnectedOverride) — unplugging drops
  // this back to the schedule's own away color on the next refresh.
  if (forced) return "rgba(255,201,77,0.35)";
  return status === "HOME" ? "rgba(94,200,255,0.32)" : "transparent";
}

export default function Timeline({ data }: { data: TimelineData }) {
  const router = useRouter();
  const appUrl = useAppUrl();
  const [hover, setHover] = useState<{ h: TimelineHour; day: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (todayRef.current && scrollRef.current) {
      const el = todayRef.current;
      const container = scrollRef.current;
      container.scrollLeft = el.offsetLeft - container.offsetLeft - 12;
    }
  }, []);

  const { maxPrice, minPrice, maxSolar, maxGridW } = useMemo(() => {
    let maxP = 0.0001,
      minP = Infinity,
      maxS = 1,
      maxG = 0;
    for (const d of data.days)
      for (const h of d.hours) {
        if (h.allInPrice != null) {
          maxP = Math.max(maxP, h.allInPrice);
          minP = Math.min(minP, h.allInPrice);
        }
        maxS = Math.max(maxS, h.solarWh);
        // Measured PV is watts, not per-slot Wh; /4 converts a 15-min average into the
        // same per-slot-Wh scale the forecast area uses, so both can share one axis.
        if (h.pvWatts != null) maxS = Math.max(maxS, h.pvWatts / 4);
        // One shared symmetric scale across every day, so a dip below the zero line
        // means the same amount of export wherever you look.
        if (h.gridWatts != null) maxG = Math.max(maxG, Math.abs(h.gridWatts));
        maxG = Math.max(maxG, h.forecastSurplusW);
      }
    if (!isFinite(minP)) minP = 0;
    return { maxPrice: maxP, minPrice: minP, maxSolar: maxS, maxGridW: Math.max(500, maxG) };
  }, [data]);

  const nowMs = new Date(data.now).getTime();

  async function saveOverride(body: Record<string, unknown>) {
    await fetch(appUrl("/api/day/override"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    router.refresh();
  }

  return (
    <div className="panel-hero p-5 sm:p-6">
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <defs>
          <linearGradient id="gradCheap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3fa37a" />
            <stop offset="100%" stopColor="#2e9e6e" />
          </linearGradient>
          <linearGradient id="gradMid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d98536" />
            <stop offset="100%" stopColor="#c96f26" />
          </linearGradient>
          <linearGradient id="gradExpensive" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c9584f" />
            <stop offset="100%" stopColor="#b94943" />
          </linearGradient>
        </defs>
      </svg>

      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)]">
          Energy timeline
        </div>
        <Legend />
      </div>

      <div className="relative -mx-5 sm:-mx-6">
        <div
          ref={scrollRef}
          className="flex gap-8 overflow-x-auto px-5 pb-2 pt-3 sm:px-6"
          style={{
            maskImage:
              "linear-gradient(90deg, transparent, black 32px, black calc(100% - 40px), transparent)",
            WebkitMaskImage:
              "linear-gradient(90deg, transparent, black 32px, black calc(100% - 40px), transparent)",
          }}
        >
          {data.days.map((day) => (
            <div key={day.dateISO} ref={day.isToday ? todayRef : undefined}>
              <DayChart
                day={day}
                maxPrice={maxPrice}
                minPrice={minPrice}
                maxSolar={maxSolar}
                maxGridW={maxGridW}
                nowMs={nowMs}
                editable={day.isToday || day.isFuture}
                onHover={(h) => setHover(h ? { h, day: day.label } : null)}
                onSaveTarget={(deadlineTime, targetSoc) =>
                  saveOverride({ date: day.dateISO, target: { deadlineTime, targetSoc } })
                }
                onSaveAvailability={(availability) =>
                  saveOverride({ date: day.dateISO, availability })
                }
              />
            </div>
          ))}
        </div>
      </div>
      <HoverInfo hover={hover} />
    </div>
  );
}

function DayChart({
  day,
  maxPrice,
  minPrice,
  maxSolar,
  maxGridW,
  nowMs,
  editable,
  onHover,
  onSaveTarget,
  onSaveAvailability,
}: {
  day: TimelineDay;
  maxPrice: number;
  minPrice: number;
  maxSolar: number;
  maxGridW: number;
  nowMs: number;
  editable: boolean;
  onHover: (h: TimelineHour | null) => void;
  onSaveTarget: (deadlineTime: string, targetSoc: number) => void;
  onSaveAvailability: (availability: { hour: number; status: AvailStatus }[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const width = day.hours.length * COL + PAD_X * 2;
  const xFor = (i: number) => PAD_X + i * COL;

  // --- Editable morning target (draggable handle) ---
  const [target, setTarget] = useState<{ deadlineTime: string; targetSoc: number }>({
    deadlineTime: day.deadlineTime,
    targetSoc: day.targetSoc,
  });
  const [dragging, setDragging] = useState(false);
  // Keep the local target in sync when the server data changes (and we're not dragging).
  useEffect(() => {
    if (!dragging) setTarget({ deadlineTime: day.deadlineTime, targetSoc: day.targetSoc });
  }, [day.deadlineTime, day.targetSoc, dragging]);

  // --- Editable per-hour availability (coarser than the 15-min price/charge grid:
  // home/away windows are still hour-granularity — see buildWindows in the day/override
  // API route). Every 4th slot marks the start of an hour.
  const hoursPerDay = Math.round(day.hours.length / 4);
  const [avail, setAvail] = useState<AvailStatus[]>(() =>
    day.hours.filter((_, i) => i % 4 === 0).map((h) => h.availability)
  );
  useEffect(() => {
    setAvail(day.hours.filter((_, i) => i % 4 === 0).map((h) => h.availability));
  }, [day.hours]);
  const availAt = (hourIdx: number): AvailStatus =>
    editable ? avail[hourIdx] ?? "AWAY" : day.hours[hourIdx * 4]?.availability ?? "AWAY";
  // Live signal, not part of the editable draft — always read straight from the
  // server data so it tracks the charger's actual connected state.
  const forcedHomeAt = (hourIdx: number): boolean =>
    day.hours.slice(hourIdx * 4, hourIdx * 4 + 4).some((h) => h.forcedHome);

  const svgPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * SVG_H,
    };
  };

  // x-position -> "HH:MM" of the 15-min column under the cursor (each column IS a slot).
  const timeFromX = (x: number): string => {
    const raw = (x - PAD_X) / COL;
    const idx = Math.max(0, Math.min(day.hours.length - 1, Math.floor(raw)));
    const h = day.hours[idx];
    return `${String(h.localHour).padStart(2, "0")}:${String(h.localMinute).padStart(2, "0")}`;
  };

  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const { x, y } = svgPoint(e.clientX, e.clientY);
    setTarget({ deadlineTime: timeFromX(x), targetSoc: Math.max(0, Math.min(100, socFromY(y))) });
  };
  const onHandleUp = () => {
    if (!dragging) return;
    setDragging(false);
    onSaveTarget(target.deadlineTime, target.targetSoc);
  };

  const toggleHour = (hourIdx: number) => {
    const next = avail.slice();
    next[hourIdx] = NEXT_STATUS[next[hourIdx] ?? "AWAY"];
    setAvail(next);
    onSaveAvailability(
      next.map((status, idx) => ({ hour: day.hours[idx * 4]?.localHour ?? idx, status }))
    );
  };

  // Solar area path
  const solarPts = day.hours.map((h, i) => {
    const x = xFor(i) + COL / 2;
    const y = PRICE_BOTTOM - (h.solarWh / maxSolar) * PRICE_H;
    return `${x},${y}`;
  });
  const solarArea =
    day.hours.length > 0
      ? `M ${xFor(0) + COL / 2},${PRICE_BOTTOM} L ${solarPts.join(" L ")} L ${
          xFor(day.hours.length - 1) + COL / 2
        },${PRICE_BOTTOM} Z`
      : "";
  // The curve itself, drawn separately from the fill so it can be dashed — dashed reads
  // as "prediction" at a glance, next to the solid measured line below.
  const solarLine = solarPts.length > 0 ? `M ${solarPts.join(" L ")}` : "";

  // Measured PV trace — the actual sensor reading, overlaid on the forecast area above.
  // Only drawn where a reading exists, so a day with no solar entity configured (or one
  // that hasn't reported yet) shows just the forecast, not a line pinned to zero.
  const pvPts = day.hours.map((h, i) => ({
    x: xFor(i) + COL / 2,
    y: h.pvWatts != null ? PRICE_BOTTOM - (Math.min(maxSolar, h.pvWatts / 4) / maxSolar) * PRICE_H : null,
  }));
  const pvPath = (() => {
    const seg = pvPts.filter((p): p is { x: number; y: number } => p.y != null);
    return seg.length < 2 ? "" : `M ${seg.map((p) => `${p.x},${p.y}`).join(" L ")}`;
  })();

  // --- Net grid power trace ---
  // Zero sits below the middle of the price panel so exports have room to swing down
  // without the trace colliding with the tall price bars at the top.
  const GRID_ZERO_Y = PRICE_TOP + PRICE_H * 0.55;
  const GRID_SPAN = PRICE_H * 0.4;
  const gridY = (w: number) =>
    GRID_ZERO_Y - Math.max(-1, Math.min(1, w / maxGridW)) * GRID_SPAN;
  const clipId = `exportclip-${day.dateISO}`;

  // Measured where we have samples, forecast beyond that. Forecast export is negative
  // because exporting is negative grid power.
  const gridPts = day.hours.map((h, i) => ({
    x: xFor(i) + COL / 2,
    w: h.gridWatts ?? (h.isPast ? null : -h.forecastSurplusW),
    measured: h.gridWatts != null,
  }));
  const runToPath = (pts: { x: number; w: number | null }[]) => {
    const seg = pts.filter((p) => p.w != null) as { x: number; w: number }[];
    if (seg.length < 2) return "";
    return `M ${seg.map((p) => `${p.x},${gridY(p.w)}`).join(" L ")}`;
  };
  const gridPast = runToPath(gridPts.map((p) => ({ ...p, w: p.measured ? p.w : null })));
  const gridFuture = runToPath(gridPts.map((p) => ({ ...p, w: p.measured ? null : p.w })));
  const gridDefined = gridPts.filter((p) => p.w != null) as { x: number; w: number }[];
  const hasGridTrace = gridDefined.length >= 2;
  // Filled band between the trace and zero, clipped to below the zero line so only the
  // exporting part is shaded.
  const gridArea = hasGridTrace
    ? `M ${gridDefined[0].x},${GRID_ZERO_Y} L ${gridDefined
        .map((p) => `${p.x},${gridY(p.w)}`)
        .join(" L ")} L ${gridDefined[gridDefined.length - 1].x},${GRID_ZERO_Y} Z`
    : "";

  // Deadline + now marker positions (fraction of the day by local hour)
  const markerX = (iso: string | null): number | null => {
    if (!iso) return null;
    const idx = day.hours.findIndex((h) => h.hourStart === iso);
    if (idx >= 0) return xFor(idx);
    // fall back to matching by time within the day's range
    const t = new Date(iso).getTime();
    for (let i = 0; i < day.hours.length; i++) {
      const hs = new Date(day.hours[i].hourStart).getTime();
      if (hs >= t) return xFor(i);
    }
    return null;
  };

  // For an editable day, position the deadline from the (possibly dragged) local time.
  // day.hours[0] is always local midnight, so total minutes / slot size gives a
  // continuous column offset (fractional when hhmm isn't on a 15-min boundary).
  const deadlineXFromTime = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return xFor((h * 60 + m) / SLOT_MINUTES);
  };
  const deadlineX = editable ? deadlineXFromTime(target.deadlineTime) : markerX(day.deadlineHour);
  const targetY = socY(target.targetSoc);

  let nowX: number | null = null;
  for (let i = 0; i < day.hours.length; i++) {
    const hs = new Date(day.hours[i].hourStart).getTime();
    if (hs <= nowMs && nowMs < hs + SLOT_MS) {
      nowX = xFor(i) + ((nowMs - hs) / SLOT_MS) * COL;
      break;
    }
  }

  return (
    <div className="shrink-0" style={{ minWidth: width }}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3 text-sm">
        <span className={day.isToday ? "font-bold" : "font-semibold text-[var(--color-muted)]"}>
          {day.label}
          {day.isToday ? <span className="font-medium text-[var(--color-muted)]"> · today</span> : ""}
          {day.isOverride ? " ✎" : ""}
        </span>
        <span className="font-mono text-xs text-[var(--color-accent)]">
          target {editable ? target.targetSoc : day.targetSoc}% @ {editable ? target.deadlineTime : day.deadlineTime}
        </span>
      </div>
      <svg
        ref={svgRef}
        width={width}
        height={SVG_H}
        className={editable ? "block touch-none" : "block"}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerLeave={onHandleUp}
      >
        {/* chart background */}
        <rect
          x={PAD_X - 4}
          y={PRICE_TOP - 4}
          width={width - PAD_X * 2 + 8}
          height={PRICE_H + 8}
          rx={10}
          fill="rgba(0,0,0,0.22)"
          stroke="rgba(255,255,255,0.05)"
        />

        {/* availability band background — hour-granularity, one block per 4 slot columns */}
        {Array.from({ length: hoursPerDay }, (_, hourIdx) => (
          <rect
            key={`av-${hourIdx}`}
            x={xFor(hourIdx * 4)}
            y={AVAIL_Y}
            width={COL * 4}
            height={AVAIL_H}
            fill={availFill(availAt(hourIdx), forcedHomeAt(hourIdx))}
          />
        ))}

        {/* price bars */}
        {day.hours.map((h, i) => {
          if (h.allInPrice == null) return null;
          const ratio = priceRatio(h.allInPrice, maxPrice);
          const barH = Math.max(2, ratio * PRICE_H);
          return (
            <rect
              key={`p-${i}`}
              x={xFor(i) + 1}
              y={PRICE_BOTTOM - barH}
              width={COL - 2}
              height={barH}
              rx={1.5}
              fill={barFill(ratio)}
              opacity={h.isPast ? 0.42 : 0.92}
            />
          );
        })}

        {/* solar forecast — dashed to read as "prediction" next to the solid measured
            line below. Area fill has no stroke of its own; solarLine draws the curve. */}
        {solarArea && <path d={solarArea} fill="rgba(255,216,115,0.18)" stroke="none" />}
        {solarLine && (
          <path
            d={solarLine}
            fill="none"
            stroke="var(--color-solar)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.9}
          />
        )}

        {/* measured PV trace — the actual reading from the configured solar entity */}
        {pvPath && <path d={pvPath} fill="none" stroke="var(--color-solar)" strokeWidth={1.8} opacity={0.95} />}

        {/* net grid power — the direct read on "am I exporting right now". Measured
            (solid) for slots we have samples for, forecast (dashed) ahead of now. The
            filled area below the zero line is power going back to the grid: exactly what
            surplus charging is meant to swallow. */}
        <defs>
          <clipPath id={clipId}>
            <rect
              x={PAD_X}
              y={GRID_ZERO_Y}
              width={width - PAD_X * 2}
              height={Math.max(0, PRICE_BOTTOM - GRID_ZERO_Y)}
            />
          </clipPath>
        </defs>
        {gridArea && <path d={gridArea} fill="rgba(53,208,196,0.22)" clipPath={`url(#${clipId})`} />}
        {gridPast && (
          <path d={gridPast} fill="none" stroke="var(--color-export)" strokeWidth={1.3} opacity={0.85} />
        )}
        {gridFuture && (
          <path
            d={gridFuture}
            fill="none"
            stroke="var(--color-export)"
            strokeWidth={1.2}
            strokeDasharray="3 3"
            opacity={0.55}
          />
        )}
        {hasGridTrace && (
          <line
            x1={PAD_X}
            y1={gridY(0)}
            x2={width - PAD_X}
            y2={gridY(0)}
            stroke="rgba(255,255,255,0.18)"
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        )}

        {/* planned charge band — amber for target charging, green for opportunistic
            cheap-price charging, teal for solar surplus (see CHARGE_STYLE) */}
        {day.hours.map((h, i) => {
          if (!h.planned) return null;
          const { color, glow } = chargeStyle(h.plannedReason);
          return (
            <rect
              key={`c-${i}`}
              x={xFor(i) + 1}
              y={CHARGE_Y}
              width={COL - 2}
              height={CHARGE_H}
              rx={3}
              fill={color}
              opacity={0.9}
              style={{ filter: `drop-shadow(0 0 6px ${glow})` }}
            />
          );
        })}
        {/* actual charge (history) outline, coloured by the mode that actually ran */}
        {day.hours.map((h, i) =>
          h.actualMode ? (
            <rect
              key={`a-${i}`}
              x={xFor(i) + 1}
              y={CHARGE_Y}
              width={COL - 2}
              height={CHARGE_H}
              rx={3}
              fill="none"
              stroke={chargeStyle(h.actualMode === "surplus" ? "surplus" : "target").color}
              strokeWidth={1.5}
            />
          ) : null
        )}

        {/* hour hover targets + a few labels */}
        {day.hours.map((h, i) => (
          <g key={`hover-${i}`}>
            <rect
              x={xFor(i)}
              y={PRICE_TOP}
              width={COL}
              height={CHARGE_Y + CHARGE_H - PRICE_TOP}
              fill="transparent"
              onMouseEnter={() => onHover(h)}
              onMouseLeave={() => onHover(null)}
            />
            {h.localMinute === 0 && h.localHour % 6 === 0 && (
              <text
                x={xFor(i) + COL / 2}
                y={LABEL_Y}
                textAnchor="middle"
                fontSize="10"
                fontFamily="var(--font-mono)"
                fill="var(--color-muted)"
              >
                {String(h.localHour).padStart(2, "0")}
              </text>
            )}
          </g>
        ))}

        {/* editable per-hour home/away toggle cells (drawn on top so they get the clicks).
            Note: no SVG <title> tooltip here — React 19 hoists <title> as document
            metadata, which mismatches on hydration inside SVG. Hover forwards to the
            detail bar instead. */}
        {editable &&
          Array.from({ length: hoursPerDay }, (_, hourIdx) => (
            <rect
              key={`edit-${hourIdx}`}
              x={xFor(hourIdx * 4) + 0.5}
              y={AVAIL_Y}
              width={COL * 4 - 1}
              height={AVAIL_H}
              rx={3}
              fill={availFill(availAt(hourIdx), forcedHomeAt(hourIdx))}
              stroke="rgba(94,200,255,0.5)"
              strokeWidth={0.5}
              style={{ cursor: "pointer" }}
              onClick={() => toggleHour(hourIdx)}
              onMouseEnter={() => onHover(day.hours[hourIdx * 4])}
              onMouseLeave={() => onHover(null)}
            />
          ))}

        {/* deadline marker */}
        {deadlineX != null && (
          <line
            x1={deadlineX}
            y1={PRICE_TOP - 2}
            x2={deadlineX}
            y2={CHARGE_Y + CHARGE_H}
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            strokeDasharray="3 2"
          />
        )}

        {/* editable target: horizontal SOC line + draggable handle */}
        {editable && deadlineX != null && (
          <g>
            <line
              x1={PAD_X}
              y1={targetY}
              x2={width - PAD_X}
              y2={targetY}
              stroke="var(--color-accent)"
              strokeWidth={1}
              strokeDasharray="2 3"
              opacity={0.6}
            />
            {/* larger invisible hit area for easier grabbing */}
            <circle
              cx={deadlineX}
              cy={targetY}
              r={12}
              fill="transparent"
              style={{ cursor: "grab" }}
              onPointerDown={onHandleDown}
            />
            <circle
              cx={deadlineX}
              cy={targetY}
              r={6}
              fill="var(--color-accent)"
              stroke="#161207"
              strokeWidth={1.5}
              style={{
                cursor: dragging ? "grabbing" : "grab",
                pointerEvents: "none",
                filter: "drop-shadow(0 0 8px rgba(255,201,77,0.8))",
              }}
            />
            <text
              x={Math.min(deadlineX + 9, width - PAD_X)}
              y={Math.max(targetY - 8, PRICE_TOP + 8)}
              textAnchor={deadlineX > width - 60 ? "end" : "start"}
              fontSize="10"
              fontWeight={700}
              fontFamily="var(--font-mono)"
              fill="var(--color-accent)"
              style={{ pointerEvents: "none" }}
            >
              {target.targetSoc}% @ {target.deadlineTime}
            </text>
          </g>
        )}

        {/* now marker */}
        {nowX != null && (
          <line
            x1={nowX}
            y1={PRICE_TOP - 4}
            x2={nowX}
            y2={CHARGE_Y + CHARGE_H}
            stroke="#ffffff"
            strokeWidth={1.4}
            style={{ filter: "drop-shadow(0 0 4px rgba(255,255,255,0.6))" }}
          />
        )}
      </svg>
      {editable && (
        <div className="mt-1.5 text-[10px] leading-tight text-[var(--color-muted)]">
          Drag ● to set this day&apos;s target · tap the home bar to toggle home/away
        </div>
      )}
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [
    ["var(--color-cheap)", "cheap"],
    ["var(--color-mid)", "mid"],
    ["var(--color-expensive)", "expensive"],
    ["var(--color-charge)", "charging (target)"],
    ["var(--color-charge-cheap)", "charging (cheap)"],
    ["var(--color-charge-surplus)", "charging (solar surplus)"],
    ["rgba(53,208,196,0.22)", "exporting to grid"],
    ["rgba(94,200,255,0.32)", "home"],
    ["rgba(255,201,77,0.35)", "home (plugged in)"],
  ];
  return (
    <div className="flex flex-wrap gap-4 text-[11px] text-[var(--color-muted)]">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-2.5" style={{ background: "var(--color-solar)" }} /> solar
        (measured)
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-0 w-3 border-t-2 border-dashed"
          style={{ borderColor: "var(--color-solar)" }}
        />{" "}
        solar (forecast)
      </span>
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-0.5 bg-[var(--color-accent)]" /> deadline
      </span>
    </div>
  );
}

function HoverInfo({ hover }: { hover: { h: TimelineHour; day: string } | null }) {
  if (!hover) {
    return <div className="mt-2 h-5 text-xs text-[var(--color-muted)]">Hover an hour for details.</div>;
  }
  const { h, day } = hover;
  // Both sides of the price: what a kWh costs to import, and the much lower amount the
  // same kWh earns if it goes back to the grid instead of into the car.
  const price =
    h.allInPrice != null
      ? `€${h.allInPrice.toFixed(3)}/kWh${
          h.feedInPrice != null ? ` (export €${h.feedInPrice.toFixed(3)})` : ""
        }`
      : "no price";
  const grid =
    h.gridWatts != null
      ? ` · ${h.gridWatts < 0 ? "exporting" : "importing"} ${Math.abs(Math.round(h.gridWatts))} W`
      : h.forecastSurplusW > 1
        ? ` · ~${Math.round(h.forecastSurplusW)} W export forecast`
        : "";
  return (
    <div className="mt-2 h-5 font-mono text-xs text-[var(--color-text)]">
      <span className="font-sans text-[var(--color-muted)]">{day}</span>{" "}
      {String(h.localHour).padStart(2, "0")}:{String(h.localMinute).padStart(2, "0")} · {price} · ☀{" "}
      {(h.solarWh / 1000).toFixed(2)} kWh forecast
      {h.pvWatts != null ? ` (${Math.round(h.pvWatts)} W measured)` : ""}
      {grid} · {h.availability.toLowerCase()}
      {h.forcedHome ? " (plugged in)" : ""}
      {h.planned
        ? ` · charging ${h.plannedKwh.toFixed(1)} kWh @ ${h.plannedAmps} A (${chargeStyle(h.plannedReason).label})`
        : ""}
    </div>
  );
}
