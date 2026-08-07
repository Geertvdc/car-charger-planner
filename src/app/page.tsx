import Timeline from "@/components/Timeline";
import { buildTimeline } from "@/lib/timeline";
import { prisma } from "@/lib/db";
import RefreshButton from "@/components/RefreshButton";
import SocEditor from "@/components/SocEditor";
import SimulationBar from "@/components/SimulationBar";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [data, plan, car, latestSoc, settings] = await Promise.all([
    buildTimeline().catch((e) => {
      console.error("[dashboard] buildTimeline failed:", (e as Error).message);
      return null;
    }),
    prisma.planState.findUnique({ where: { id: 1 } }),
    prisma.carConfig.findUnique({ where: { id: 1 } }),
    prisma.carState.findFirst({ orderBy: { at: "desc" } }),
    prisma.settings.findUnique({ where: { id: 1 } }),
  ]);
  const tz = data?.tz ?? settings?.timezone ?? "Europe/Amsterdam";

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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatusCard plan={plan} />
        <div className="panel p-4">
          <div className="label">Current charge</div>
          <SocEditor initialSoc={latestSoc?.soc ?? 50} />
          <div className="mt-2 text-xs text-[var(--color-muted)]">
            Battery {car?.batteryKwh ?? "?"} kWh · charger {car?.chargerPowerKw ?? "?"} kW
          </div>
        </div>
        <div className="panel p-4">
          <div className="label">Plan feasibility</div>
          {plan?.feasible ? (
            <div className="font-semibold text-[var(--color-cheap)]">On track ✓</div>
          ) : (
            <div className="font-semibold text-[var(--color-expensive)]">
              Short by {(plan?.shortfallKwh ?? 0).toFixed(1)} kWh
            </div>
          )}
          <div className="mt-1 text-xs text-[var(--color-muted)]">{plan?.reason || "No plan computed yet."}</div>
        </div>
      </div>

      <SimulationBar
        simulatedNowISO={settings?.simulatedNow ? settings.simulatedNow.toISOString() : null}
        tz={tz}
      />
    </div>
  );
}

function StatusCard({
  plan,
}: {
  plan: { charging: boolean; chargingUntil: Date | null; targetSoc: number | null } | null;
}) {
  const charging = plan?.charging ?? false;
  return (
    <div className="panel p-4">
      <div className="label">Charger right now</div>
      <div className={`text-lg font-bold ${charging ? "text-[var(--color-charge)]" : "text-[var(--color-muted)]"}`}>
        {charging ? "⚡ Charging" : "◌ Idle"}
      </div>
      <div className="mt-1 text-xs text-[var(--color-muted)]">
        {plan?.targetSoc ? `Target ${plan.targetSoc}%` : "No active target"}
      </div>
    </div>
  );
}
