import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { recomputePlan } from "@/lib/plan";

export const dynamic = "force-dynamic";

// Body: { op: "set", datetime: "2026-08-06T15:00" } | { op: "step", deltaMin: 60 } | { op: "clear" }
export async function POST(req: Request) {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  const tz = settings?.timezone ?? "Europe/Amsterdam";
  const body = await req.json().catch(() => ({}));

  let next: Date | null = null;
  if (body.op === "set") {
    const dt = DateTime.fromISO(String(body.datetime ?? ""), { zone: tz });
    if (!dt.isValid) return NextResponse.json({ error: "invalid datetime" }, { status: 400 });
    next = dt.toUTC().toJSDate();
  } else if (body.op === "step") {
    const base = settings?.simulatedNow ?? new Date();
    const deltaMin = Number(body.deltaMin) || 0;
    next = new Date(base.getTime() + deltaMin * 60_000);
  } else if (body.op === "clear") {
    next = null;
  } else {
    return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }

  try {
    await prisma.settings.update({ where: { id: 1 }, data: { simulatedNow: next } });
    await recomputePlan().catch(() => undefined);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, simulatedNow: next ? next.toISOString() : null });
}
