#!/bin/sh
set -e

# Ensure the SQLite schema exists / is up to date on the mounted volume.
echo "[entrypoint] syncing database schema..."
node_modules/.bin/prisma db push --skip-generate --accept-data-loss

echo "[entrypoint] starting server..."
exec node server.js
