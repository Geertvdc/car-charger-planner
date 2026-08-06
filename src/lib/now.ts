import { prisma } from "./db";

/**
 * The effective "now". In simulation mode (Settings.simulatedNow set) this is the
 * simulated instant; otherwise the real clock. An explicit override always wins.
 */
export function resolveNow(simulatedNow: Date | null, override?: Date): Date {
  return override ?? simulatedNow ?? new Date();
}

/** Convenience for callers that don't already have Settings loaded. */
export async function effectiveNow(override?: Date): Promise<Date> {
  if (override) return override;
  const s = await prisma.settings.findUnique({ where: { id: 1 } });
  return s?.simulatedNow ?? new Date();
}
