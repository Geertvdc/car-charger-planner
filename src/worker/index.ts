// Optional standalone scheduler process (run with `npm run worker`).
// Use this instead of the in-process instrumentation hook by setting
// DISABLE_SCHEDULER=1 on the web container and running this in a second one.
import { startScheduler } from "../lib/scheduler";

startScheduler();

// Keep the process alive.
setInterval(() => {}, 1 << 30);
console.log("[worker] running");
