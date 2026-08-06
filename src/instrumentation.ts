// Runs once when the Next.js server process boots (Node.js runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Make sure the singleton config rows exist before anything reads them.
  const { ensureSingletons } = await import("./lib/bootstrap");
  await ensureSingletons().catch((e) =>
    console.error("[bootstrap] ensureSingletons failed:", (e as Error).message)
  );
  // Opt out with DISABLE_SCHEDULER=1 (e.g. when running a separate worker container).
  if (process.env.DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
