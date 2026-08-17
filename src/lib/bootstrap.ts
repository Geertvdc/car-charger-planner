import { prisma } from "./db";

/**
 * Settings fields that can be primed from the environment, with the value Prisma
 * gives them on a fresh row. Seeding applies only while a field still holds that
 * default, so anything edited in the UI is never overwritten — the database stays
 * the source of truth and .env is just the starting point.
 */
const ENV_SEEDED_FIELDS = [
  { field: "haBaseUrl", env: "HA_BASE_URL", fallback: "" },
  { field: "haAccessToken", env: "HA_ACCESS_TOKEN", fallback: "" },
  { field: "haChargerSwitchEntityId", env: "HA_CHARGER_SWITCH_ENTITY_ID", fallback: "" },
  { field: "haChargerStatusEntityId", env: "HA_CHARGER_STATUS_ENTITY_ID", fallback: "" },
  { field: "haChargerConnectedEntityId", env: "HA_CHARGER_CONNECTED_ENTITY_ID", fallback: "" },
  { field: "haPowerSensorEntityId", env: "HA_POWER_SENSOR_ENTITY_ID", fallback: "" },
  { field: "haChargerPowerEntityId", env: "HA_CHARGER_POWER_ENTITY_ID", fallback: "" },
  { field: "haSolarPowerEntityId", env: "HA_SOLAR_POWER_ENTITY_ID", fallback: "" },
  { field: "haCarSocEntityId", env: "HA_CAR_SOC_ENTITY_ID", fallback: "" },
  { field: "haChargerOnService", env: "HA_CHARGER_ON_SERVICE", fallback: "switch.turn_on" },
  { field: "haChargerOffService", env: "HA_CHARGER_OFF_SERVICE", fallback: "switch.turn_off" },
  { field: "haChargerCurrentEntityId", env: "HA_CHARGER_CURRENT_ENTITY_ID", fallback: "" },
  {
    field: "haChargerCurrentService",
    env: "HA_CHARGER_CURRENT_SERVICE",
    fallback: "number.set_value",
  },
  { field: "haChargerCurrentValueKey", env: "HA_CHARGER_CURRENT_VALUE_KEY", fallback: "value" },
] as const;

/**
 * Copy Home Assistant configuration from the environment into the Settings row.
 *
 * The entity IDs live only in the database, so a fresh database — a new git worktree,
 * a rebuilt container, a wiped volume — otherwise starts with them blank and the app
 * silently stops controlling anything until they're re-entered by hand. Seeding from
 * .env makes that setup reproducible.
 *
 * Idempotent and non-destructive: a field is written only while it still holds its
 * default, so this can run on every boot and a later UI edit always wins.
 */
export async function seedSettingsFromEnv(): Promise<string[]> {
  const settings = await prisma.settings.findUnique({ where: { id: 1 } });
  if (!settings) return [];

  const data: Record<string, string> = {};
  for (const { field, env, fallback } of ENV_SEEDED_FIELDS) {
    const raw = process.env[env]?.trim();
    if (!raw) continue;
    const current = (settings as unknown as Record<string, string>)[field];
    if (current !== fallback) continue; // user-edited — leave it alone
    data[field] = field === "haBaseUrl" ? raw.replace(/\/+$/, "") : raw;
  }

  const applied = Object.keys(data);
  if (applied.length > 0) {
    await prisma.settings.update({ where: { id: 1 }, data });
    // Names only — one of these is a long-lived access token.
    console.log(`[bootstrap] seeded from environment: ${applied.join(", ")}`);
  }
  return applied;
}

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

  await seedSettingsFromEnv();

  if (firstBoot && (await prisma.weeklyDay.count()) === 0) {
    // Neutral default: home all day, ready to 80% by 07:00. The user narrows this
    // down to their real availability on the Weekly schedule page.
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      await prisma.weeklyDay.create({
        data: {
          dayOfWeek,
          deadlineTime: "07:00",
          targetSoc: 80,
          windows: { create: [{ startTime: "00:00", endTime: "23:59" }] },
        },
      });
    }
  }
}
