import { prisma } from "./db";
import { logDecisionTransition } from "./ha";
import { applyChargeCommand } from "./ha-control";
import { resolveNow } from "./now";
import { ChargeCommand, ChargeMode, PowerSample, resolveChargeCommand } from "./surplus";

/**
 * How far back to look for power samples. At the scheduler's 30 s cadence this is ~10
 * readings, enough for the median to reject a spike without lagging a real load change
 * by more than a couple of minutes.
 */
const SAMPLE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Reconcile the plan's intent with the live grid reading and push the result to the
 * charger. This is the **only** thing that operates hardware: recomputePlan() records
 * what it wants on PlanState and calls in here, and the 30 s scheduler tick calls in here
 * too. Two writers racing each other over the same charger switch would be much worse
 * than a slightly stale current limit.
 *
 * Never throws — a controller that dies takes the charger with it.
 */
export async function runChargeController(nowOverride?: Date): Promise<ChargeCommand | undefined> {
  try {
    const [settings, car, plan, latestSoc] = await Promise.all([
      prisma.settings.findUniqueOrThrow({ where: { id: 1 } }),
      prisma.carConfig.findUniqueOrThrow({ where: { id: 1 } }),
      prisma.planState.findUniqueOrThrow({ where: { id: 1 } }),
      prisma.carState.findFirst({ orderBy: { at: "desc" } }),
    ]);
    const now = resolveNow(settings.simulatedNow, nowOverride);

    const rows = await prisma.powerReading.findMany({
      where: { at: { gte: new Date(now.getTime() - SAMPLE_WINDOW_MS) } },
      orderBy: { at: "desc" },
    });
    // A sample is only usable when we know what the car was taking at that moment: the
    // grid figure includes the charger, so without it the loop would read its own draw as
    // household import and immediately throttle itself back to nothing.
    const samples: PowerSample[] = rows
      .filter((r) => r.chargerWatts != null)
      .map((r) => ({ at: r.at, gridWatts: r.watts, chargerWatts: r.chargerWatts as number }));

    const command = resolveChargeCommand({
      now,
      samples,
      enabled: settings.surplusChargingEnabled,
      connected: plan.chargerConnected,
      soc: latestSoc?.soc ?? 50,
      maxSoc: car.maxSoc,
      // A slot the engine labelled "surplus" is only a *forecast* that the sun will cover
      // it. The measurement below is the authority on whether that surplus actually
      // exists, so it must not force the charger on by itself.
      planOn: plan.plannedOn && plan.plannedReason !== "surplus",
      planAmps: plan.plannedAmps ?? car.maxCurrentA,
      phases: car.phases,
      voltage: car.voltage,
      minCurrentA: car.minCurrentA,
      maxCurrentA: car.maxCurrentA,
      reserveWatts: settings.surplusReserveWatts,
      startDelayMs: settings.surplusStartDelayMin * 60_000,
      stopDelayMs: settings.surplusStopDelayMin * 60_000,
      surplusSinceAt: plan.surplusSinceAt,
      deficitSinceAt: plan.deficitSinceAt,
      currentMode: plan.mode as ChargeMode,
      currentAmps: plan.commandedAmps ?? car.minCurrentA,
    });

    await prisma.planState.update({
      where: { id: 1 },
      data: {
        charging: command.on,
        mode: command.mode,
        commandedAmps: command.on ? command.amps : null,
        surplusSinceAt: command.surplusSinceAt,
        deficitSinceAt: command.deficitSinceAt,
      },
    });

    await applyChargeCommand(command).catch(() => undefined);
    await logDecisionTransition(command.on, command.mode, command.amps).catch(() => undefined);
    return command;
  } catch (e) {
    console.error("[controller] tick failed:", (e as Error).message);
    return undefined;
  }
}
