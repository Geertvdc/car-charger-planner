import { prisma } from "./db";
import type { ChargeMode } from "./surplus";

/**
 * Record a served decision only when it differs from the last log entry (clean step
 * history). The mode is part of that comparison, so a switch from plan to surplus
 * charging shows up in history even though the charger stayed on throughout.
 * Amps deliberately are not: they move continuously in surplus mode and would turn the
 * log into a sample stream.
 */
export async function logDecisionTransition(
  on: boolean,
  mode: ChargeMode = on ? "plan" : "off",
  amps?: number
): Promise<void> {
  const last = await prisma.chargeLog.findFirst({ orderBy: { at: "desc" } });
  if (!last || last.on !== on || last.mode !== mode) {
    await prisma.chargeLog.create({ data: { on, mode, amps: amps ?? null } });
  }
}
