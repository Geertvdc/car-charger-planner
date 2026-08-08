import { NextResponse } from "next/server";
import { checkHaAuth, currentChargeDecision, logDecisionTransition } from "@/lib/ha";

export const dynamic = "force-dynamic";

// Legacy/manual-fallback route: the app now pushes charger on/off to HA directly
// (see src/lib/ha-control.ts, invoked from src/lib/plan.ts). Kept as an escape hatch
// for a poll-based HA automation instead of granting this app write access to HA.
// Plain "on"/"off" body for a trivial HA command_line / REST sensor.
export async function GET(req: Request) {
  if (!(await checkHaAuth(req))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const { on } = await currentChargeDecision();
  await logDecisionTransition(on);
  return new NextResponse(on ? "on" : "off", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
