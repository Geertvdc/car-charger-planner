"use client";

import { DateTime } from "luxon";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function SimulationBar({
  simulatedNowISO,
  tz,
}: {
  simulatedNowISO: string | null;
  tz: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const active = simulatedNowISO != null;
  const effective = simulatedNowISO ? DateTime.fromISO(simulatedNowISO, { zone: tz }) : null;
  // Seed the input from the simulated instant if set; otherwise fill the live clock
  // after mount so the server/client first render match (avoids a hydration mismatch).
  const [inputValue, setInputValue] = useState(
    effective ? effective.toFormat("yyyy-MM-dd'T'HH:mm") : ""
  );
  useEffect(() => {
    if (!simulatedNowISO && !inputValue) {
      setInputValue(DateTime.now().setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm"));
    }
  }, [simulatedNowISO, tz, inputValue]);
  // Auto-expand once a simulation is active so the state is visible.
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

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
    <div className="panel-soft p-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg bg-transparent px-2.5 py-2 text-left text-xs font-semibold text-[var(--color-text)]"
      >
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: active ? "var(--color-accent)" : "var(--color-home)",
            animation: "pulseDot 2s ease-in-out infinite",
          }}
        />
        Simulation{" "}
        {active ? (
          <span className="font-mono font-medium text-[var(--color-accent)]">
            {effective?.toFormat("ccc dd LLL HH:mm")}
          </span>
        ) : (
          <span className="font-medium text-[var(--color-muted)]">off · live clock</span>
        )}
        <span className="ml-auto text-[var(--color-muted)]">{open ? "▲ hide" : "▼ show"}</span>
      </button>

      {open && (
        <div className="flex flex-wrap items-center gap-3.5 px-2.5 pb-2 pt-1">
          <div className="flex items-center gap-1.5">
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
                className="btn px-2.5 py-1 text-xs"
                onClick={() => call({ op: "step", deltaMin: b.v })}
              >
                {b.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 sm:ml-auto">
            <input
              className="input w-auto"
              type="datetime-local"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <button
              type="button"
              disabled={busy}
              className="btn btn-primary px-3.5 py-1 text-xs"
              onClick={() => call({ op: "set", datetime: inputValue })}
            >
              Set
            </button>
          </div>

          {active && (
            <button
              type="button"
              disabled={busy}
              className="btn px-3 py-1 text-xs"
              onClick={() => call({ op: "clear" })}
            >
              ▶ Back to live
            </button>
          )}

          {active && (
            <p className="w-full text-xs text-[var(--color-muted)]">
              The planner, timeline and Home Assistant endpoints all treat the time above as
              &ldquo;now&rdquo;. Click <strong>Back to live</strong> to return to the real clock.
              Only today/tomorrow have price &amp; solar data.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
