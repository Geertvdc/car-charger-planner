#!/bin/sh
set -e

# As a Home Assistant add-on the persistent volume is /data; as a plain Docker
# container it's whatever the compose file mounts there. Either way the schema is
# synced onto it before the server starts.
DATA_DIR="$(dirname "${DATA_FILE:-/data/app.db}")"
mkdir -p "$DATA_DIR"

echo "[entrypoint] syncing database schema..."
# Invoke the CLI from its package path so it finds its sibling .wasm files
# (a copied .bin/prisma symlink loses them).
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss

echo "[entrypoint] starting server on :${PORT:-3000}..."
# The ingress entrypoint runs `next start` on a loopback port and fronts it with a
# proxy that adapts responses for Home Assistant Ingress. Served directly (no
# X-Ingress-Path header) the proxy is a transparent pass-through.
exec node_modules/.bin/tsx src/ingress/index.ts
