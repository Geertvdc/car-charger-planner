# syntax=docker/dockerfile:1

FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder URL just so `next build` / prisma generate succeed at build time.
ENV DATABASE_URL="file:/data/app.db"
RUN npx prisma generate && npm run build

# ---- runner ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# PORT is the public port (the add-on's ingress_port); Next itself runs on
# NEXT_INTERNAL_PORT bound to loopback, behind the ingress proxy.
ENV PORT=3000
ENV NEXT_INTERNAL_PORT=3001
ENV HOSTNAME=0.0.0.0
# /data is the Home Assistant add-on's persistent volume, and the compose file mounts
# its volume at the same path — one database location for both deployments.
ENV DATABASE_URL="file:/data/app.db?connection_limit=1"

# Full app + node_modules: reliable (the Prisma CLI + its transitive deps are all
# present for the startup `db push`, and `next start` serves the build). Larger image
# than the standalone bundle, but bulletproof for a self-hosted personal app.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/tsconfig.json ./tsconfig.json
# The ingress proxy runs from source via tsx (like the worker), so it needs src/.
COPY --from=builder /app/src ./src

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN mkdir -p /data && chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
