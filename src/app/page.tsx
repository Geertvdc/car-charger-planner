import Timeline from "@/components/Timeline";
import { buildTimeline } from "@/lib/timeline";
import { prisma } from "@/lib/db";
import RefreshButton from "@/components/RefreshButton";
import SimulationBar from "@/components/SimulationBar";
import StatTile from "@/components/StatTile";

export const dynamic = "force-dynamic";

function formatAge(at: Date): string {
  const minutesAgo = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
  if (minutesAgo < 1) return "just now";
  if (minutesAgo === 1) return "1 min ago";
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  const hoursAgo = Math.round(minutesAgo / 60);
  return hoursAgo === 1 ? "1 h ago" : `${hoursAgo} h ago`;
}

export default async function DashboardPage() {
  const [data, plan, latestSoc, settings, latestPower] = await Promise.all([
    buildTimeline().catch((e) => {
      console.error("[dashboard] buildTimeline failed:", (e as Error).message);
      return null;
    }),
    prisma.planState.findUnique({ where: { id: 1 } }),
    prisma.carState.findFirst({ orderBy: { at: "desc" } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
    prisma.powerReading.findFirst({ orderBy: { at: "desc" } }),
  ]);
  const tz = data?.tz ?? settings?.timezone ?? "Europe/Amsterdam";

  // The plan's own decision, plus what the charger itself is reporting — the two can
  // diverge (a manual start, a session this app didn't schedule), and the tile should
  // reflect reality, not just intent.
  const planned = plan?.charging ?? false;
  const reportedByCharger = plan?.chargerReportedCharging ?? false;
  const charging = planned || reportedByCharger;
  const feasible = plan?.feasible ?? true;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold tracking-tight">Dashboard</h1>
        <RefreshButton />
      </div>

      {data ? (
        <Timeline data={data} />
      ) : (
        <div className="panel-hero p-6 text-[var(--color-muted)]">
          Couldn&apos;t load the timeline just now — hit “Refresh data &amp; plan” to try again.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={charging ? "⚡" : "◌"}
          accent={charging ? "var(--color-charge)" : "var(--color-muted)"}
          label="Charger right now"
          value={charging ? "Charging" : "Idle"}
          valueColor={charging ? "var(--color-charge)" : undefined}
          caption={
            charging && !planned
              ? "Charging outside the plan (reported by charger)"
              : plan?.targetSoc
                ? `Target ${plan.targetSoc}%`
                : "No active target"
          }
        />
        <StatTile
          icon="🔋"
          accent="var(--color-home)"
          label="Current charge"
          value={latestSoc ? `${latestSoc.soc}%` : "—"}
          caption={latestSoc ? `Updated ${formatAge(latestSoc.at)}` : undefined}
        />
        <StatTile
          icon={feasible ? "✓" : "⚠"}
          accent={feasible ? "var(--color-cheap)" : "var(--color-expensive)"}
          label="Plan feasibility"
          value={feasible ? "On track" : `Short ${(plan?.shortfallKwh ?? 0).toFixed(1)} kWh`}
          valueColor={feasible ? "var(--color-cheap)" : "var(--color-expensive)"}
          caption={plan?.reason || "No plan computed yet."}
        />
        {latestPower && (
          <StatTile
            icon="🏠"
            accent="var(--color-solar)"
            label="Home power (HA)"
            value={`${(latestPower.watts / 1000).toFixed(2)} kW`}
            caption={`${latestPower.watts >= 0 ? "Importing" : "Exporting"} · ${formatAge(latestPower.at)}`}
          />
        )}
      </div>

      <SimulationBar
        simulatedNowISO={settings?.simulatedNow ? settings.simulatedNow.toISOString() : null}
        tz={tz}
      />
    </div>
  );
}
