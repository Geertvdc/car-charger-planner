import { refreshAll, refreshChargerConnected } from "./refresh";
import { recomputePlan } from "./plan";

const g = globalThis as unknown as {
  __chargerSchedulerStarted?: boolean;
  __chargerTimers?: NodeJS.Timeout[];
};

const REFRESH_MS = 30 * 60 * 1000; // full data refresh + recompute every 30 min
const RECOMPUTE_MS = 60 * 1000; // advance the plan "now" pointer every 1 min

/**
 * Background schedule using plain intervals (no external cron dep, bundles cleanly).
 * Idempotent — safe to call from the Next.js instrumentation hook and/or a worker.
 *
 * A 30-min refresh comfortably covers: tomorrow's prices (published ~13:00 and picked
 * up on the next tick) and periodic solar updates. The engine plans in 15-min slots;
 * recompute runs every 1 min (15x/slot) both to keep the HA on/off sync tight to a
 * slot boundary and, more importantly, to pick up a charger-plugged-in event quickly —
 * this is a cheap local HA REST call, not a rate-limited cloud API, so a short interval
 * costs nothing.
 */
export function startScheduler(): void {
  if (g.__chargerSchedulerStarted) return;
  g.__chargerSchedulerStarted = true;
  g.__chargerTimers = [];

  // Initial catch-up shortly after boot.
  setTimeout(() => run("startup", () => refreshAll()), 4000);

  g.__chargerTimers.push(setInterval(() => run("refresh", () => refreshAll()), REFRESH_MS));
  g.__chargerTimers.push(
    setInterval(
      () =>
        run("recompute", async () => {
          // Background-only HA read (not in the interactive recomputePlan() path) so
          // "charger connected" stays fresh within ~1 min without adding a live HA
          // round-trip to every settings save / timeline edit.
          await refreshChargerConnected().catch(() => undefined);
          return recomputePlan();
        }),
      RECOMPUTE_MS
    )
  );

  console.log("[scheduler] started");
}

async function run(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    await recomputePlan().catch(() => undefined);
    console.log(`[scheduler] ${name} ok`);
  } catch (e) {
    console.error(`[scheduler] ${name} failed:`, (e as Error).message);
  }
}
