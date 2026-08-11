import { spawn } from "node:child_process";
import { startIngressProxy } from "./proxy";

/**
 * Container entrypoint: runs `next start` on a loopback-only port and fronts it with
 * the Ingress proxy on the public port. One process supervises both, so if Next dies
 * the container exits and the restart policy (or the Supervisor) takes over.
 *
 * PORT is the port the outside world connects to — 8099 to match `ingress_port` when
 * running as a Home Assistant add-on, 3000 for a plain Docker deployment.
 */
const LISTEN_PORT = Number(process.env.PORT ?? 3000);
const NEXT_PORT = Number(process.env.NEXT_INTERNAL_PORT ?? 3001);

// Resolve Next's CLI through module resolution rather than a relative bin path, so the
// entrypoint doesn't depend on the working directory it was launched from.
const nextBin = require.resolve("next/dist/bin/next");

const next = spawn(
  process.execPath,
  [nextBin, "start", "-H", "127.0.0.1", "-p", String(NEXT_PORT)],
  { stdio: "inherit", env: { ...process.env, PORT: String(NEXT_PORT) } }
);

const proxy = startIngressProxy({ listenPort: LISTEN_PORT, upstreamPort: NEXT_PORT });

next.on("exit", (code, signal) => {
  console.error(`[ingress] next exited (code=${code} signal=${signal}); shutting down`);
  proxy.close();
  process.exit(code ?? 1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    next.kill(signal);
    proxy.close();
  });
}
