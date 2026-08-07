"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailStatus } from "@/lib/availability";
import type { TimelineData, TimelineDay, TimelineHour } from "@/lib/timeline";

const COL = 30; // px per hour
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

// Cycle a home/away state on tap: away → home → maybe → away.
const NEXT_STATUS: Record<AvailStatus, AvailStatus> = {
  AWAY: "DEFINITE",
  DEFINITE: "MAYBE",
  MAYBE: "AWAY",
};

function priceRatio(price: number, maxPrice: number): number {
  return price / maxPrice;
}

function barFill(ratio: number): string {
  if (ratio < 0.4) return "url(#gradCheap)";
  if (ratio < 0.66) return "url(#gradMid)";
  return "url(#gradExpensive)";
}

function availFill(status: string): string {
  if (status === "DEFINITE") return "rgba(94,200,255,0.32)";
  if (status === "MAYBE") return "rgba(94,200,255,0.12)";
  return "transparent";
}

export default function Timeline({ data }: { data: TimelineData }) {
  const router = useRouter();
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

  const { maxPrice, minPrice, maxSolar } = useMemo(() => {
    let maxP = 0.0001,
      minP = Infinity,
      maxS = 1;
    for (const d of data.days)
      for (const h of d.hours) {
        if (h.allInPrice != null) {
          maxP = Math.max(maxP, h.allInPrice);
          minP = Math.min(minP, h.allInPrice);
        }
        maxS = Math.max(maxS, h.solarWh);
      }
    if (!isFinite(minP)) minP = 0;
    return { maxPrice: maxP, minPrice: minP, maxSolar: maxS };
  }, [data]);

  const nowMs = new Date(data.now).getTime();

  async function saveOverride(body: Record<string, unknown>) {
    await fetch("/api/day/override", {
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

  // --- Editable per-hour availability ---
  const [avail, setAvail] = useState<AvailStatus[]>(() => day.hours.map((h) => h.availability));
  useEffect(() => {
    setAvail(day.hours.map((h) => h.availability));
  }, [day.hours]);
  const availAt = (i: number): AvailStatus => (editable ? avail[i] ?? "AWAY" : day.hours[i].availability);

  const svgPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * SVG_H,
    };
  };

  // x-position -> "HH:MM" snapped to 15 min, using each column's local hour.
  const timeFromX = (x: number): string => {
    const raw = (x - PAD_X) / COL;
    const idx = Math.max(0, Math.min(day.hours.length - 1, Math.floor(raw)));
    const frac = Math.max(0, Math.min(0.999, raw - idx));
    let hour = day.hours[idx].localHour;
    let minute = Math.round((frac * 60) / 15) * 15;
    if (minute >= 60) {
      minute = 0;
      hour = Math.min(23, hour + 1);
    }
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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

  const toggleHour = (i: number) => {
    const next = avail.slice();
    next[i] = NEXT_STATUS[next[i] ?? "AWAY"];
    setAvail(next);
    onSaveAvailability(day.hours.map((h, idx) => ({ hour: h.localHour, status: next[idx] ?? "AWAY" })));
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
  const deadlineXFromTime = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    const idx = day.hours.findIndex((hr) => hr.localHour === h);
    const base = idx >= 0 ? idx : h;
    return xFor(base) + (m / 60) * COL;
  };
  const deadlineX = editable ? deadlineXFromTime(target.deadlineTime) : markerX(day.deadlineHour);
  const targetY = socY(target.targetSoc);

  let nowX: number | null = null;
  for (let i = 0; i < day.hours.length; i++) {
    const hs = new Date(day.hours[i].hourStart).getTime();
    if (hs <= nowMs && nowMs < hs + 3600_000) {
      nowX = xFor(i) + ((nowMs - hs) / 3600_000) * COL;
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

        {/* availability band background */}
        {day.hours.map((h, i) => (
          <rect
            key={`av-${i}`}
            x={xFor(i)}
            y={AVAIL_Y}
            width={COL}
            height={AVAIL_H}
            fill={availFill(availAt(i))}
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
              x={xFor(i) + 2}
              y={PRICE_BOTTOM - barH}
              width={COL - 4}
              height={barH}
              rx={3}
              fill={barFill(ratio)}
              opacity={h.isPast ? 0.42 : 0.92}
            />
          );
        })}

        {/* solar area */}
        {solarArea && (
          <path d={solarArea} fill="rgba(255,216,115,0.18)" stroke="var(--color-solar)" strokeWidth={1.5} />
        )}

        {/* planned charge band */}
        {day.hours.map((h, i) =>
          h.planned ? (
            <rect
              key={`c-${i}`}
              x={xFor(i) + 1}
              y={CHARGE_Y}
              width={COL - 2}
              height={CHARGE_H}
              rx={3}
              fill="var(--color-charge)"
              opacity={0.9}
              style={{ filter: "drop-shadow(0 0 6px rgba(255,201,77,0.6))" }}
            />
          ) : null
        )}
        {/* actual charge (history) outline */}
        {day.hours.map((h, i) =>
          h.actual ? (
            <rect
              key={`a-${i}`}
              x={xFor(i) + 1}
              y={CHARGE_Y}
              width={COL - 2}
              height={CHARGE_H}
              rx={3}
              fill="none"
              stroke="var(--color-charge)"
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
            {h.localHour % 6 === 0 && (
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
          day.hours.map((h, i) => (
            <rect
              key={`edit-${i}`}
              x={xFor(i) + 0.5}
              y={AVAIL_Y}
              width={COL - 1}
              height={AVAIL_H}
              rx={3}
              fill={availFill(availAt(i))}
              stroke="rgba(94,200,255,0.5)"
              strokeWidth={0.5}
              style={{ cursor: "pointer" }}
              onClick={() => toggleHour(i)}
              onMouseEnter={() => onHover(h)}
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
          Drag ● to set this day&apos;s target · tap the home bar to toggle home/maybe/away
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
    ["var(--color-solar)", "solar"],
    ["var(--color-charge)", "charging"],
    ["rgba(94,200,255,0.32)", "home"],
  ];
  return (
    <div className="flex flex-wrap gap-4 text-[11px] text-[var(--color-muted)]">
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
  return (
    <div className="mt-2 h-5 font-mono text-xs text-[var(--color-text)]">
      <span className="font-sans text-[var(--color-muted)]">{day}</span> {String(h.localHour).padStart(2, "0")}:00 ·{" "}
      {h.allInPrice != null ? `€${h.allInPrice.toFixed(3)}/kWh` : "no price"} · ☀ {(h.solarWh / 1000).toFixed(2)} kWh ·{" "}
      {h.availability.toLowerCase()}
      {h.planned ? ` · charging ${h.plannedKwh.toFixed(1)} kWh` : ""}
    </div>
  );
}
