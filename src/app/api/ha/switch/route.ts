import { NextResponse } from "next/server";
import { checkHaAuth, currentChargeDecision, logDecisionTransition } from "@/lib/ha";

export const dynamic = "force-dynamic";

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
