#!/usr/bin/env bash
set -euo pipefail

pnpm --dir apps/api exec prisma migrate deploy
exec node apps/api/dist/main.js
