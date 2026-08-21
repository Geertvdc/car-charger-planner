"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { recomputePlan } from "@/lib/plan";
import { geocodePlace } from "@/lib/geocode";
import { refreshAll } from "@/lib/refresh";

const num = (v: FormDataEntryValue | null, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: FormDataEntryValue | null, d = "") => (typeof v === "string" ? v : d);
const numOrNull = (v: FormDataEntryValue | null): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/settings");
  revalidatePath("/config");
  revalidatePath("/schedule");
  revalidatePath("/upcoming");
}

// Simulation mode is handled by the /api/simulation route (client fetch), not a
// server action — see src/app/api/simulation/route.ts.

// ---- Location by name (geocode) ----
export async function geocodeLocation(formData: FormData) {
  const query = str(formData.get("locationName")).trim();
  if (!query) return;
  const geo = await geocodePlace(query).catch(() => null);
  if (!geo) return;
  await prisma.settings.update({
    where: { id: 1 },
    data: {
      locationName: geo.name,
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone: geo.timezone,
    },
  });
  // New coordinates change the solar forecast; refresh + replan.
  await refreshAll().catch(() => undefined);
  await revalidateAll();
}

// ---- Settings ----
export async function saveSettings(formData: FormData) {
  await prisma.settings.update({
    where: { id: 1 },
    data: {
      locationName: str(formData.get("locationName")),
      latitude: num(formData.get("latitude"), 52.37),
      longitude: num(formData.get("longitude"), 4.9),
      timezone: str(formData.get("timezone"), "Europe/Amsterdam"),
      energyTaxPerKwh: num(formData.get("energyTaxPerKwh")),
      supplierFeePerKwh: num(formData.get("supplierFeePerKwh")),
      vatRate: num(formData.get("vatRate")),
      feedInBasis: str(formData.get("feedInBasis"), "market") === "fixed" ? "fixed" : "market",
      feedInFeePerKwh: num(formData.get("feedInFeePerKwh")),
      feedInInclVat: formData.get("feedInInclVat") != null,
      feedInTariffPerKwh: num(formData.get("feedInTariffPerKwh")),
      houseLoadFactor: Math.min(1, Math.max(0, num(formData.get("houseLoadFactor"), 0.7))),
      cheapPriceThresholdPerKwh: numOrNull(formData.get("cheapPriceThresholdPerKwh")),
      historyDays: Math.max(0, Math.round(num(formData.get("historyDays"), 3))),
      surplusChargingEnabled: formData.get("surplusChargingEnabled") != null,
      surplusReserveWatts: Math.max(0, Math.round(num(formData.get("surplusReserveWatts"), 0))),
      surplusStartDelayMin: Math.max(0, Math.round(num(formData.get("surplusStartDelayMin"), 2))),
      surplusStopDelayMin: Math.max(0, Math.round(num(formData.get("surplusStopDelayMin"), 10))),
      haBaseUrl: str(formData.get("haBaseUrl")).trim().replace(/\/+$/, ""),
      haAccessToken: str(formData.get("haAccessToken")),
      haChargerSwitchEntityId: str(formData.get("haChargerSwitchEntityId")).trim(),
      haChargerStatusEntityId: str(formData.get("haChargerStatusEntityId")).trim(),
      haChargerConnectedEntityId: str(formData.get("haChargerConnectedEntityId")).trim(),
      haChargerOnService: str(formData.get("haChargerOnService"), "switch.turn_on").trim(),
      haChargerOffService: str(formData.get("haChargerOffService"), "switch.turn_off").trim(),
      haPowerSensorEntityId: str(formData.get("haPowerSensorEntityId")).trim(),
      haChargerPowerEntityId: str(formData.get("haChargerPowerEntityId")).trim(),
      haSolarPowerEntityId: str(formData.get("haSolarPowerEntityId")).trim(),
      haChargerCurrentEntityId: str(formData.get("haChargerCurrentEntityId")).trim(),
      haChargerCurrentService: str(
        formData.get("haChargerCurrentService"),
        "number.set_value"
      ).trim(),
      haChargerCurrentValueKey: str(formData.get("haChargerCurrentValueKey"), "value").trim(),
      haCarSocEntityId: str(formData.get("haCarSocEntityId")).trim(),
    },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}

// ---- Car ----
export async function saveCar(formData: FormData) {
  await prisma.carConfig.update({
    where: { id: 1 },
    data: {
      batteryKwh: num(formData.get("batteryKwh"), 58),
      chargerPowerKw: num(formData.get("chargerPowerKw"), 11),
      efficiency: Math.min(1, Math.max(0.5, num(formData.get("efficiency"), 0.9))),
      minSoc: Math.round(num(formData.get("minSoc"), 10)),
      maxSoc: Math.round(num(formData.get("maxSoc"), 90)),
      phases: Math.max(1, Math.min(3, Math.round(num(formData.get("phases"), 3)))),
      voltage: Math.max(100, Math.round(num(formData.get("voltage"), 230))),
      // Never let the floor drop below the IEC 61851 minimum of 6 A — a car simply
      // refuses to charge below it, and a "successful" push would silently stop charging.
      minCurrentA: Math.max(6, Math.round(num(formData.get("minCurrentA"), 6))),
      maxCurrentA: Math.max(6, Math.round(num(formData.get("maxCurrentA"), 16))),
    },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}

// ---- Weekly template ----
export async function saveWeeklyDay(formData: FormData) {
  const dayOfWeek = Math.round(num(formData.get("dayOfWeek")));
  await prisma.weeklyDay.upsert({
    where: { dayOfWeek },
    create: {
      dayOfWeek,
      deadlineTime: str(formData.get("deadlineTime"), "07:00"),
      targetSoc: Math.round(num(formData.get("targetSoc"), 80)),
    },
    update: {
      deadlineTime: str(formData.get("deadlineTime"), "07:00"),
      targetSoc: Math.round(num(formData.get("targetSoc"), 80)),
    },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}
export async function addWeeklyWindow(formData: FormData) {
  const dayOfWeek = Math.round(num(formData.get("dayOfWeek")));
  const day = await prisma.weeklyDay.upsert({
    where: { dayOfWeek },
    create: { dayOfWeek },
    update: {},
  });
  await prisma.homeWindow.create({
    data: {
      weeklyDayId: day.id,
      startTime: str(formData.get("startTime"), "00:00"),
      endTime: str(formData.get("endTime"), "23:59"),
    },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}

// ---- Overrides ----
export async function saveOverride(formData: FormData) {
  const date = str(formData.get("date"));
  if (!date) return;
  const deadlineTime = str(formData.get("deadlineTime")) || null;
  const targetRaw = formData.get("targetSoc");
  const targetSoc = targetRaw ? Math.round(num(targetRaw)) : null;
  const away = formData.get("away") === "on";
  const note = str(formData.get("note")) || null;
  await prisma.dayOverride.upsert({
    where: { date },
    create: { date, deadlineTime, targetSoc, away, note },
    update: { deadlineTime, targetSoc, away, note },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}
export async function addOverrideWindow(formData: FormData) {
  const date = str(formData.get("date"));
  if (!date) return;
  const ov = await prisma.dayOverride.upsert({
    where: { date },
    create: { date },
    update: {},
  });
  await prisma.homeWindow.create({
    data: {
      dayOverrideId: ov.id,
      startTime: str(formData.get("startTime"), "00:00"),
      endTime: str(formData.get("endTime"), "23:59"),
    },
  });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}
export async function deleteOverride(formData: FormData) {
  await prisma.dayOverride.delete({ where: { id: num(formData.get("id")) } });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}

// ---- Shared: delete a home window (weekly or override) ----
export async function deleteWindow(formData: FormData) {
  await prisma.homeWindow.delete({ where: { id: num(formData.get("id")) } });
  await recomputePlan().catch(() => undefined);
  await revalidateAll();
}
