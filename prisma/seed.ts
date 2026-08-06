import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// dayOfWeek: 0=Monday .. 6=Sunday
const DEFINITE = "DEFINITE";
const MAYBE = "MAYBE";

// Home overnight windows reused for "office" days.
const overnight = [
  { startTime: "00:00", endTime: "08:00", status: DEFINITE },
  { startTime: "17:30", endTime: "23:59", status: DEFINITE },
];
const allDay = [{ startTime: "00:00", endTime: "23:59", status: DEFINITE }];

const template: Record<
  number,
  { deadlineTime: string; targetSoc: number; windows: typeof allDay }
> = {
  0: { deadlineTime: "07:00", targetSoc: 80, windows: allDay }, // Mon: home
  1: { deadlineTime: "07:00", targetSoc: 80, windows: overnight }, // Tue: office
  2: {
    deadlineTime: "07:00",
    targetSoc: 80,
    windows: [
      { startTime: "00:00", endTime: "08:00", status: DEFINITE },
      { startTime: "15:00", endTime: "23:59", status: DEFINITE },
    ],
  }, // Wed: home from ~15:00
  3: { deadlineTime: "07:00", targetSoc: 80, windows: overnight }, // Thu: office
  4: { deadlineTime: "08:00", targetSoc: 80, windows: allDay }, // Fri: home
  5: {
    deadlineTime: "09:00",
    targetSoc: 70,
    windows: [{ startTime: "00:00", endTime: "23:59", status: MAYBE }],
  }, // Sat: maybe home
  6: { deadlineTime: "07:00", targetSoc: 90, windows: allDay }, // Sun: home, ready for the week
};

async function main() {
  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  await prisma.carConfig.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  await prisma.planState.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  if ((await prisma.pvString.count()) === 0) {
    await prisma.pvString.create({
      data: { name: "Roof", kwp: 4.0, tilt: 35, azimuth: 0 },
    });
  }

  if ((await prisma.carState.count()) === 0) {
    await prisma.carState.create({ data: { soc: 50, source: "manual" } });
  }

  for (const [dow, cfg] of Object.entries(template)) {
    const dayOfWeek = Number(dow);
    const existing = await prisma.weeklyDay.findUnique({ where: { dayOfWeek } });
    if (existing) continue;
    await prisma.weeklyDay.create({
      data: {
        dayOfWeek,
        deadlineTime: cfg.deadlineTime,
        targetSoc: cfg.targetSoc,
        windows: { create: cfg.windows },
      },
    });
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
