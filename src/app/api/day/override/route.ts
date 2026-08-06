import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recomputePlan } from "@/lib/plan";

// Edits made directly on the dashboard timeline for a single upcoming day.
// Both parts write to that date's DayOverride (creating it if needed) so they
// diverge from the weekly template without touching it.
const statusEnum = z.enum(["DEFINITE", "MAYBE", "AWAY"]);
const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Draggable morning-readiness target.
  target: z
    .object({
      deadlineTime: z.string().regex(/^\d{2}:\d{2}$/),
      targetSoc: z.number().int().min(0).max(100),
    })
    .optional(),
  // Per-hour home/away for the day: one entry per local hour that isn't away.
  availability: z.array(z.object({ hour: z.number().int().min(0).max(23), status: statusEnum })).optional(),
});

const pad = (n: number) => String(n).padStart(2, "0");

/** Merge per-hour statuses into contiguous home windows (AWAY hours produce no window). */
function buildWindows(entries: { hour: number; status: "DEFINITE" | "MAYBE" | "AWAY" }[]) {
  const byHour = new Map<number, "DEFINITE" | "MAYBE" | "AWAY">();
  for (const e of entries) byHour.set(e.hour, e.status);

  const windows: { startTime: string; endTime: string; status: string }[] = [];
  let h = 0;
  while (h < 24) {
    const s = byHour.get(h) ?? "AWAY";
    if (s === "AWAY") {
      h++;
      continue;
    }
    let end = h;
    while (end + 1 < 24 && (byHour.get(end + 1) ?? "AWAY") === s) end++;
    windows.push({
      startTime: `${pad(h)}:00`,
      endTime: end >= 23 ? "23:59" : `${pad(end + 1)}:00`,
      status: s,
    });
    h = end + 1;
  }
  return windows;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { date, target, availability } = parsed.data;
  if (!target && !availability) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    // Ensure the override row exists (target/deadline default to the template when null).
    await prisma.dayOverride.upsert({ where: { date }, create: { date }, update: {} });

    if (target) {
      await prisma.dayOverride.update({
        where: { date },
        data: { deadlineTime: target.deadlineTime, targetSoc: target.targetSoc },
      });
    }

    if (availability) {
      const windows = buildWindows(availability);
      // No home/maybe hours anywhere => away all day; otherwise store the windows.
      await prisma.dayOverride.update({
        where: { date },
        data: {
          away: windows.length === 0,
          windows: { deleteMany: {}, create: windows },
        },
      });
    }

    await recomputePlan().catch(() => undefined);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
