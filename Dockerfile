# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/settlement/package.json packages/settlement/package.json
RUN pnpm install --frozen-lockfile

FROM workspace AS build
ARG DEPLOYMENT_ID
COPY tsconfig.base.json eslint.config.js ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN node scripts/build/create-deployment-id.mjs "$DEPLOYMENT_ID"
# Prisma Client generation reads this variable but does not connect during the build.
ENV DATABASE_URL=mysql://build:build@127.0.0.1:3306/poker_scorekeeper_build
RUN pnpm -r build
RUN engine_path="$(find /app/node_modules/.pnpm -path '*/@prisma/engines/schema-engine-*' -type f -print -quit)" \
    && test -n "$engine_path" \
    && install -m 0555 "$engine_path" /app/prisma-schema-engine

FROM node:24-bookworm-slim AS production-dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/settlement/package.json packages/settlement/package.json
RUN pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ARG DEPLOYMENT_ID
LABEL org.opencontainers.image.revision=$DEPLOYMENT_ID
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_ROOT=/app/apps/web/dist \
    AVATAR_ROOT=/data/avatars \
    PRISMA_SCHEMA_ENGINE_BINARY=/app/prisma-schema-engine \
    PUBLIC_ORIGIN=https://poker.example.com \
    WS_ALLOWED_ORIGINS="" \
    DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper \
    SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES \
    CSRF_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES \
    BOOTSTRAP_ADMIN_USERNAME=rootadmin \
    BOOTSTRAP_ADMIN_NICKNAME=CHANGE_ME_ADMIN_NICKNAME \
    BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_UNIQUE_STRONG_PASSWORD \
    READINESS_TIMEOUT_MS=2000 \
    MYSQL_HOST=192.168.10.248 \
    MYSQL_PORT=3306 \
    MYSQL_USER=poker_backup_user \
    MYSQL_PASSWORD=CHANGE_ME \
    MYSQL_DATABASE=poker_scorekeeper \
    BACKUP_DIR=/data/backups
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates default-mysql-client gzip tar tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/avatars /data/backups /data/restore \
    && chown -R node:node /data

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=production-dependencies /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=production-dependencies /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=production-dependencies /app/packages/settlement/node_modules ./packages/settlement/node_modules
COPY --from=production-dependencies /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=production-dependencies /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies /app/apps/web/package.json ./apps/web/package.json
COPY --from=production-dependencies /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=production-dependencies /app/packages/settlement/package.json ./packages/settlement/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/settlement/dist ./packages/settlement/dist
COPY --from=build --chmod=0555 /app/prisma-schema-engine ./prisma-schema-engine
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build --chmod=0444 /app/deployment-id ./deployment-id
COPY --chmod=0555 scripts/docker/entrypoint.sh ./scripts/docker/entrypoint.sh
COPY --chmod=0444 scripts/docker/healthcheck.mjs ./scripts/docker/healthcheck.mjs
COPY --chmod=0444 scripts/database/production-preflight.mjs ./scripts/database/production-preflight.mjs
COPY --chmod=0444 scripts/database/create-database.mjs ./scripts/database/create-database.mjs
COPY --chmod=0444 scripts/database/production-backup-target.mjs ./scripts/database/production-backup-target.mjs
COPY --chmod=0444 scripts/database/assert-production-avatar-files.mjs ./scripts/database/assert-production-avatar-files.mjs
COPY --chmod=0444 scripts/database/production-migration-evidence.mjs ./scripts/database/production-migration-evidence.mjs
COPY --chmod=0555 scripts/backup/backup.sh ./scripts/backup/backup.sh
COPY --chmod=0555 scripts/backup/restore.sh ./scripts/backup/restore.sh
COPY --chmod=0444 scripts/backup/restore-input-guard.mjs ./scripts/backup/restore-input-guard.mjs

USER node
RUN test -x /app/prisma-schema-engine \
    && test -x /app/apps/api/node_modules/.bin/prisma
VOLUME ["/data/avatars", "/data/backups", "/data/restore"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "scripts/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/scripts/docker/entrypoint.sh"]
