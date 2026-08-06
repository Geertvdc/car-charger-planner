"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimelineData, TimelineDay, TimelineHour } from "@/lib/timeline";

const COL = 26; // px per hour
const PAD_X = 8;
const PRICE_TOP = 10;
const PRICE_H = 96;
const PRICE_BOTTOM = PRICE_TOP + PRICE_H;
const AVAIL_Y = PRICE_BOTTOM + 8;
const AVAIL_H = 10;
const CHARGE_Y = AVAIL_Y + AVAIL_H + 3;
const CHARGE_H = 9;
const LABEL_Y = CHARGE_Y + CHARGE_H + 14;
const SVG_H = LABEL_Y + 6;

function priceColor(ratio: number): string {
  if (ratio < 0.34) return "var(--color-cheap)";
  if (ratio < 0.67) return "var(--color-mid)";
  return "var(--color-expensive)";
}

function availFill(status: string): string {
  if (status === "DEFINITE") return "rgba(56,189,248,0.28)";
  if (status === "MAYBE") return "rgba(56,189,248,0.10)";
  return "transparent";
}

export default function Timeline({ data }: { data: TimelineData }) {
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

  return (
    <div className="panel p-3">
      <Legend />
      <div ref={scrollRef} className="mt-2 flex gap-3 overflow-x-auto pb-2">
        {data.days.map((day) => (
          <div key={day.dateISO} ref={day.isToday ? todayRef : undefined}>
            <DayChart
              day={day}
              maxPrice={maxPrice}
              minPrice={minPrice}
              maxSolar={maxSolar}
              nowMs={nowMs}
              onHover={(h) => setHover(h ? { h, day: day.label } : null)}
            />
          </div>
        ))}
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
  onHover,
}: {
  day: TimelineDay;
  maxPrice: number;
  minPrice: number;
  maxSolar: number;
  nowMs: number;
  onHover: (h: TimelineHour | null) => void;
}) {
  const width = day.hours.length * COL + PAD_X * 2;
  const xFor = (i: number) => PAD_X + i * COL;

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
  const deadlineX = markerX(day.deadlineHour);

  let nowX: number | null = null;
  for (let i = 0; i < day.hours.length; i++) {
    const hs = new Date(day.hours[i].hourStart).getTime();
    if (hs <= nowMs && nowMs < hs + 3600_000) {
      nowX = xFor(i) + ((nowMs - hs) / 3600_000) * COL;
      break;
    }
  }

  return (
    <div className="shrink-0">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className={day.isToday ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-muted)]"}>
          {day.label}
          {day.isToday ? " • today" : ""}
          {day.isOverride ? " ✎" : ""}
        </span>
        <span className="text-[var(--color-muted)]">
          🎯 {day.targetSoc}% @ {day.deadlineTime}
        </span>
      </div>
      <svg width={width} height={SVG_H} className="block">
        {/* availability band background */}
        {day.hours.map((h, i) => (
          <rect
            key={`av-${i}`}
            x={xFor(i)}
            y={AVAIL_Y}
            width={COL}
            height={AVAIL_H}
            fill={availFill(h.availability)}
          />
        ))}

        {/* price bars */}
        {day.hours.map((h, i) => {
          if (h.allInPrice == null) return null;
          const ratio =
            maxPrice > minPrice ? (h.allInPrice - minPrice) / (maxPrice - minPrice) : 0.5;
          const barH = Math.max(1, (h.allInPrice / maxPrice) * PRICE_H);
          return (
            <rect
              key={`p-${i}`}
              x={xFor(i) + 2}
              y={PRICE_BOTTOM - barH}
              width={COL - 4}
              height={barH}
              rx={2}
              fill={priceColor(ratio)}
              opacity={h.isPast ? 0.45 : 0.9}
            />
          );
        })}

        {/* solar area */}
        {solarArea && <path d={solarArea} fill="rgba(245,197,66,0.18)" stroke="var(--color-solar)" strokeWidth={1} />}

        {/* planned charge band */}
        {day.hours.map((h, i) =>
          h.planned ? (
            <rect
              key={`c-${i}`}
              x={xFor(i) + 1}
              y={CHARGE_Y}
              width={COL - 2}
              height={CHARGE_H}
              rx={2}
              fill="var(--color-charge)"
              opacity={0.85}
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
              rx={2}
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
              <text x={xFor(i) + COL / 2} y={LABEL_Y} textAnchor="middle" fontSize="9" fill="var(--color-muted)">
                {String(h.localHour).padStart(2, "0")}
              </text>
            )}
          </g>
        ))}

        {/* deadline marker */}
        {deadlineX != null && (
          <line
            x1={deadlineX}
            y1={PRICE_TOP - 2}
            x2={deadlineX}
            y2={CHARGE_Y + CHARGE_H}
            stroke="var(--color-accent)"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        )}

        {/* now marker */}
        {nowX != null && (
          <line x1={nowX} y1={PRICE_TOP - 4} x2={nowX} y2={CHARGE_Y + CHARGE_H} stroke="#fff" strokeWidth={1.2} />
        )}
      </svg>
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
    ["rgba(56,189,248,0.28)", "home"],
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-0.5 bg-[var(--color-accent)]" /> deadline
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
    <div className="mt-2 h-5 text-xs text-[var(--color-text)]">
      <span className="text-[var(--color-muted)]">{day}</span> {String(h.localHour).padStart(2, "0")}:00 ·{" "}
      {h.allInPrice != null ? `€${h.allInPrice.toFixed(3)}/kWh` : "no price"} · ☀ {(h.solarWh / 1000).toFixed(2)} kWh ·{" "}
      {h.availability.toLowerCase()}
      {h.planned ? ` · charging ${h.plannedKwh.toFixed(1)} kWh` : ""}
    </div>
  );
}
