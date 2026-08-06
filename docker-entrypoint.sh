#!/bin/sh
set -e

# Ensure the SQLite schema exists / is up to date on the mounted volume.
# Invoke the CLI from its package path so it finds its sibling .wasm files
# (a copied .bin/prisma symlink loses them).
echo "[entrypoint] syncing database schema..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss

echo "[entrypoint] starting server..."
exec node_modules/.bin/next start -H 0.0.0.0 -p "${PORT:-3000}"
