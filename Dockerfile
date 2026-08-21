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

FROM scratch AS runtime-bundle
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=production-dependencies /app/apps/web/node_modules /app/apps/web/node_modules
COPY --from=production-dependencies /app/packages/contracts/node_modules /app/packages/contracts/node_modules
COPY --from=production-dependencies /app/packages/settlement/node_modules /app/packages/settlement/node_modules
COPY --from=production-dependencies /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/
COPY --from=production-dependencies /app/apps/api/package.json /app/apps/api/package.json
COPY --from=production-dependencies /app/apps/web/package.json /app/apps/web/package.json
COPY --from=production-dependencies /app/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=production-dependencies /app/packages/settlement/package.json /app/packages/settlement/package.json
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --from=build /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /app/packages/settlement/dist /app/packages/settlement/dist
COPY --from=build --chmod=0555 /app/prisma-schema-engine /app/prisma-schema-engine
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build /app/apps/api/prisma.config.ts /app/apps/api/prisma.config.ts
COPY --from=build --chmod=0444 /app/deployment-id /app/deployment-id
COPY --chmod=0555 scripts/docker/entrypoint.sh /app/scripts/docker/entrypoint.sh
COPY --chmod=0444 scripts/docker/healthcheck.mjs /app/scripts/docker/healthcheck.mjs
COPY --chmod=0444 scripts/database/production-preflight.mjs /app/scripts/database/production-preflight.mjs
COPY --chmod=0444 scripts/database/create-database.mjs /app/scripts/database/create-database.mjs
COPY --chmod=0444 scripts/database/production-backup-target.mjs /app/scripts/database/production-backup-target.mjs
COPY --chmod=0444 scripts/database/assert-production-avatar-files.mjs /app/scripts/database/assert-production-avatar-files.mjs
COPY --chmod=0444 scripts/database/production-migration-evidence.mjs /app/scripts/database/production-migration-evidence.mjs
COPY --chmod=0555 scripts/backup/backup.sh /app/scripts/backup/backup.sh
COPY --chmod=0555 scripts/backup/restore.sh /app/scripts/backup/restore.sh
COPY --chmod=0444 scripts/backup/restore-input-guard.mjs /app/scripts/backup/restore-input-guard.mjs

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

COPY --from=runtime-bundle /app /app

USER node
RUN set -eux; \
    test -x /app/prisma-schema-engine; \
    test -x /app/apps/api/node_modules/.bin/prisma; \
    test -x /app/scripts/docker/entrypoint.sh; \
    test -r /app/scripts/docker/healthcheck.mjs; \
    test -r /app/scripts/database/production-preflight.mjs; \
    test -r /app/scripts/database/create-database.mjs; \
    test -r /app/scripts/database/production-backup-target.mjs; \
    test -r /app/scripts/database/assert-production-avatar-files.mjs; \
    test -r /app/scripts/database/production-migration-evidence.mjs; \
    test -x /app/scripts/backup/backup.sh; \
    test -x /app/scripts/backup/restore.sh; \
    test -r /app/scripts/backup/restore-input-guard.mjs
VOLUME ["/data/avatars", "/data/backups", "/data/restore"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "scripts/docker/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/scripts/docker/entrypoint.sh"]
