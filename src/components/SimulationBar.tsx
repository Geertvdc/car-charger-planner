"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function SimulationBar({
  simulatedNowISO,
  tz,
}: {
  simulatedNowISO: string | null;
  tz: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const active = simulatedNowISO != null;
  const effective = simulatedNowISO ? DateTime.fromISO(simulatedNowISO, { zone: tz }) : DateTime.now().setZone(tz);
  const [inputValue, setInputValue] = useState(effective.toFormat("yyyy-MM-dd'T'HH:mm"));

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch("/api/simulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`panel p-3 ${active ? "border-[var(--color-solar)] bg-[rgba(245,197,66,0.06)]" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold">
          🧪 Simulation
          {active ? (
            <span className="ml-2 text-[var(--color-solar)]">{effective.toFormat("ccc dd LLL HH:mm")}</span>
          ) : (
            <span className="ml-2 text-[var(--color-muted)]">off · live clock</span>
          )}
        </span>

        <div className="flex items-center gap-1">
          {[
            { label: "−1h", v: -60 },
            { label: "−15m", v: -15 },
            { label: "+15m", v: 15 },
            { label: "+1h", v: 60 },
          ].map((b) => (
            <button
              key={b.v}
              type="button"
              disabled={busy}
              className="btn px-2 py-1 text-xs"
              onClick={() => call({ op: "step", deltaMin: b.v })}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            className="input w-auto"
            type="datetime-local"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <button
            type="button"
            disabled={busy}
            className="btn btn-primary px-3 py-1 text-xs"
            onClick={() => call({ op: "set", datetime: inputValue })}
          >
            Set
          </button>
        </div>

        {active && (
          <button
            type="button"
            disabled={busy}
            className="btn ml-auto px-3 py-1 text-xs"
            onClick={() => call({ op: "clear" })}
          >
            ▶ Back to live
          </button>
        )}
      </div>
      {active && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          The planner, timeline and Home Assistant endpoints all treat the time above as
          &ldquo;now&rdquo;. Click <strong>Back to live</strong> to return to the real clock. Only
          today/tomorrow have price &amp; solar data.
        </p>
      )}
    </div>
  );
}
