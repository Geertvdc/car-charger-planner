import { prisma } from "./db";
import { effectiveNow } from "./now";
import { addHours, floorToHour } from "./time";

/**
 * Verify the caller (Home Assistant) is authorized.
 * If a token is configured (Settings.haToken or HA_API_TOKEN env), it must match
 * either the Bearer header or a ?token= query param. If none is configured, the
 * endpoint is open (assumes a trusted LAN).
 */
export async function checkHaAuth(req: Request): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const configured = (settings?.haToken?.trim() || process.env.HA_API_TOKEN?.trim() || "").trim();
  if (!configured) return true;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const q = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  return bearer === configured || q === configured;
}

export interface ChargeDecision {
  on: boolean;
  until: Date | null; // end of the current contiguous on-run
  nowHour: Date;
}

/** The charge on/off decision for the current hour, from the persisted plan. */
export async function currentChargeDecision(nowOverride?: Date): Promise<ChargeDecision> {
  const now = await effectiveNow(nowOverride);
  const nowHour = floorToHour(now);
  const onSlots = await prisma.chargeSlot.findMany({
    where: { on: true, hourStart: { gte: nowHour } },
    orderBy: { hourStart: "asc" },
  });
  const set = new Set(onSlots.map((s) => s.hourStart.getTime()));
  const on = set.has(nowHour.getTime());
  let until: Date | null = null;
  if (on) {
    let e = addHours(nowHour, 1);
    while (set.has(e.getTime())) e = addHours(e, 1);
    until = e;
  }
  return { on, until, nowHour };
}

/** Record a served decision only when it differs from the last log entry (clean step history). */
export async function logDecisionTransition(on: boolean): Promise<void> {
  const last = await prisma.chargeLog.findFirst({ orderBy: { at: "desc" } });
  if (!last || last.on !== on) {
    await prisma.chargeLog.create({ data: { on } });
  }
}
