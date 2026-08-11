import { prisma } from "./db";

/** Record a served decision only when it differs from the last log entry (clean step history). */
export async function logDecisionTransition(on: boolean): Promise<void> {
  const last = await prisma.chargeLog.findFirst({ orderBy: { at: "desc" } });
  if (!last || last.on !== on) {
    await prisma.chargeLog.create({ data: { on } });
  }
}
