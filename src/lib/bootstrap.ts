import { prisma } from "./db";

/**
 * Ensure the singleton config rows exist so the app never crashes on a fresh
 * database (e.g. a first Docker start, which only runs `prisma db push`).
 * On the very first boot only, also lay down a friendly default week so the
 * planner has something to work with. Idempotent — safe to call on every boot,
 * and it never overwrites later user edits.
 */
export async function ensureSingletons(): Promise<void> {
  const firstBoot = (await prisma.settings.findUnique({ where: { id: 1 } })) == null;

  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  await prisma.carConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  await prisma.planState.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  if (firstBoot && (await prisma.weeklyDay.count()) === 0) {
    // Neutral default: home all day, ready to 80% by 07:00. The user narrows this
    // down to their real availability on the Weekly schedule page.
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      await prisma.weeklyDay.create({
        data: {
          dayOfWeek,
          deadlineTime: "07:00",
          targetSoc: 80,
          windows: { create: [{ startTime: "00:00", endTime: "23:59", status: "DEFINITE" }] },
        },
      });
    }
  }
}
