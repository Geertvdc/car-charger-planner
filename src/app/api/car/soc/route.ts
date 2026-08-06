import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { recomputePlan } from "@/lib/plan";

const schema = z.object({ soc: z.number().int().min(0).max(100) });

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid soc" }, { status: 400 });
  }
  await prisma.carState.create({ data: { soc: parsed.data.soc, source: "manual" } });
  await recomputePlan().catch(() => undefined);
  return NextResponse.json({ ok: true });
}
