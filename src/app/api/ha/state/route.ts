import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkHaAuth, currentChargeDecision, logDecisionTransition } from "@/lib/ha";
import { effectiveNow } from "@/lib/now";

export const dynamic = "force-dynamic";

// Legacy/manual-fallback route: the app now pushes charger on/off to HA directly
// (see src/lib/ha-control.ts, invoked from src/lib/plan.ts). This GET endpoint is no
// longer required for normal operation — kept for debugging (inspect the computed
// decision without touching HA) and as an escape hatch for a poll-based HA automation
// if you'd rather not grant this app write access to your HA instance.
// Richer JSON for HA REST sensor + attributes.
export async function GET(req: Request) {
  if (!(await checkHaAuth(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const now = await effectiveNow();
  const [{ on, until }, plan, upcoming] = await Promise.all([
    currentChargeDecision(now),
    prisma.planState.findUnique({ where: { id: 1 } }),
    prisma.chargeSlot.findMany({
      where: { on: true, hourStart: { gte: now } },
      orderBy: { hourStart: "asc" },
    }),
  ]);
  await logDecisionTransition(on);

  return NextResponse.json(
    {
      charging: on,
      state: on ? "on" : "off",
      until: until?.toISOString() ?? null,
      targetSoc: plan?.targetSoc ?? null,
      feasible: plan?.feasible ?? true,
      shortfallKwh: plan?.shortfallKwh ?? 0,
      reason: plan?.reason ?? "",
      computedAt: plan?.computedAt?.toISOString() ?? null,
      schedule: upcoming.map((s) => ({
        start: s.hourStart.toISOString(),
        kwh: Math.round(s.expectedKwh * 100) / 100,
        cost: Math.round(s.expectedCost * 1000) / 1000,
        source: s.source,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
