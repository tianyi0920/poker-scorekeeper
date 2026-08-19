# Task 19 Report — Synology Production Preflight and Live-Acceptance Readiness

## Status

`DONE_WITH_CONCERNS`

All safely executable Task 19 code, tests, documentation, and offline verification are complete on `codex/poker-scorekeeper`. No production deployment or live acceptance was performed. The production record remains explicitly `NOT_EXECUTED`.

Baseline was clean at `0b1cbcf1bc6566e6543752997020c0ec029ea506`. No command connected to, queried, created, migrated, backed up, restored, or modified `192.168.10.248:3306/poker_scorekeeper`. No command used the database password previously exposed in chat, and no credential, Cookie, token, connection URL, or other secret was printed or committed.

## Delivered

- Exact production target validation accepts only MySQL at `192.168.10.248:3306/poker_scorekeeper`; malformed URLs, alternate protocols, implicit/wrong ports, remote-test hosts, and wrong schemas fail with controlled codes that do not reflect input.
- A read-only preflight connects without selecting a possibly absent schema, uses only static `SELECT`, `SHOW GRANTS`, and session-level `USE`, and reports server version, current database, `utf8mb4`, schema existence, creation capability, and use capability. Driver and permission details are replaced with controlled codes; reports never include the password or full connection URL.
- Production database creation reuses the exact target guard before connection. The production Compose sets `PRODUCTION_TARGET_REQUIRED=1`; its entrypoint runs the read-only target preflight before any explicit one-off command, migration, or normal API start.
- The entrypoint now honors commands supplied by `docker compose run`. This repairs the inherited behavior where the documented preflight command was ignored and the container instead migrated and started the API.
- Reversible public acceptance validates an exact root HTTPS origin, ready health plus HSTS, bootstrap-super-admin login, CSRF, forced password rotation, temporary ordinary-user creation, empty-game creation/start, a WebSocket-only Socket.IO room join with acknowledgement, empty-game void, and temporary-user logical deletion. It never buys chips or creates a financial settlement.
- Acceptance cleanup is limited to IDs returned by this run. It deletes an owned draft or voids an owned active empty game, then logically deletes the owned temporary user. HTTP-success state is recorded before response-body validation, so a malformed success response cannot select the wrong cleanup action.
- Acceptance output contains only fixed PASS fields and a UTC timestamp. A strict recorder accepts only a SHA-256 image digest, committed migration name, controlled health/backup results, an exact backup stamp, three exact backup filenames/checksums, and an ISO UTC acceptance time, then writes only `docs/deployment/production-verification.md`.
- The production checklist and Synology runbook make rotated credentials, independent session/CSRF secrets, the exact HTTPS origin, Docker/Compose capabilities, directory modes, fixed database target, loopback-only port, reverse-proxy/WebSocket/real-IP settings, router TCP 443 boundary, real-phone observation, first backup, and secret-free evidence mandatory.
- `.env.example` now includes the required secret-free `SESSION_SECRET` placeholder. The initial verification document contains no fabricated evidence and remains `NOT_EXECUTED`.

## Task 19 Plan Defect and Ruling

The inherited Docker entrypoint ignored every explicit image command. Therefore the planned command:

```sh
docker compose run --rm app node scripts/database/production-preflight.mjs
```

would not run the preflight. It would execute `prisma migrate deploy` and start the API, causing production mutation before the intended read-only gate. This contradicted the Task 19 order and the explicit fail-closed requirement.

Ruling: explicit commands must be executed by the entrypoint. In the production Compose, every explicit command other than the preflight itself first runs the same read-only exact-target gate; normal startup also gates before migration. The isolated test Compose does not set `PRODUCTION_TARGET_REQUIRED`, so its internal `mysql:3306/poker_scorekeeper_test` flow remains unchanged.

## TDD and Debugging Evidence

- Initial validator RED: the focused Task 19 suite failed collection because `production-preflight.mjs` did not exist. The approved three-case validator then passed 3/3.
- Read-only preflight RED: 3 new behaviors failed because `runProductionPreflight` did not exist; after the minimal implementation the complete group passed 9/9.
- Public acceptance RED: the suite failed because `verify-production.mjs` did not exist; HTTPS/HSTS, CSRF, reversible cleanup, WSS, and secret-free formatter behaviors then passed 17/17.
- Recorder RED: 1/18 failed because `writeProductionVerificationRecord` did not exist; it passed after adding only the fixed-path validated writer.
- Cleanup-state RED: a malformed HTTP 200 start response caused cleanup to issue draft deletion after the server had committed ACTIVE. The focused assertion observed `DELETE .../draft` instead of `POST .../void`; state recording at each successful HTTP boundary made the complete Task 19 group pass 19/19.
- Production creation RED: the production validation-mode command accepted `tianyi.wiki:8306/poker_scorekeeper`; 1/6 failed. Reusing the exact target validator made the group pass 6/6 without connecting.
- Compose/entrypoint policy RED: 2/9 failed because the production-only gate and pre-migration preflight were absent; both passed after the minimal Compose and entrypoint change.
- Entrypoint command RED was independently reproduced by temporarily removing the new direct-command branch: the fake migration ran and exited 90 instead of the requested command's 23. Restoring the branch made the full real-Bash entrypoint group pass 3/3, including existing TERM forwarding and migration-status preservation.
- The first shell attempt with a copied Bash executable exited Windows code `0xC0000135` before executing tests. Root cause was its missing adjacent runtime. Re-running with the runtime's adjacent `bash-task17.exe` produced authoritative RED/GREEN behavior.

## Verification

All commands used Node 24.19.0 and pnpm 10.15.1. Prisma generation/type/build used only `mysql://build:build@127.0.0.1:3306/poker_scorekeeper_build`, which does not connect.

- Task 19 focused suite: 19/19 passed.
- Production/database safety validation: 6/6 passed.
- Production deployment artifact policy: 9/9 passed.
- Real Bash entrypoint behavior/signal group: 3/3 passed.
- `@poker/contracts`: 53/53 passed.
- `@poker/settlement`: 14/14 passed.
- `@poker/web`: 125/125 passed.
- API pure unit/static/script group: 171 passed, one existing Windows-only `O_NOFOLLOW` test skipped.
- Root workspace `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed.
- Direct ESLint for the new `.mjs` and Task 19 test files: passed.
- `node --check` for both new Node scripts and Bash syntax for the entrypoint: passed.
- Runtime LF checks, `git diff --check`, and changed-file credential/private-key/token scan: passed.
- `pnpm audit --prod --audit-level high`: no known vulnerabilities.
- `pnpm verify:release`: exited 1 at `scripts/verify-release.ps1:40` because `docker` is not installed. It failed before `gate: pnpm install --frozen-lockfile` and never emitted `release verification passed`, preserving the mandatory Docker gate.

No database-backed API/browser test was run in Task 19 because the only previously authorized remote target is not the production target and production access is expressly forbidden. The database-independent tests above are the complete safe scope for this environment.

## Production Boundary and Required Context

Production remains blocked until the user explicitly provides all of the following through secure, untracked local environment files and an approved operational channel:

1. Confirmation that the password exposed in chat has been rotated and invalidated; only the new credential may be used.
2. Exact bootstrap-super-admin username, nickname, current initial password, and a distinct new password.
3. Independent `SESSION_SECRET` and `CSRF_SECRET` values.
4. The final root `https://` `PUBLIC_ORIGIN`.
5. A supported way to operate the Synology and a Docker-capable environment with Compose 2.34.0 or newer.
6. User participation for the real-phone HTTPS/WSS observation and approval for directory, database, migration, container, reverse-proxy, router, backup, and acceptance mutations.

Do not use the old password as a fallback. Do not infer any missing value. Until the above is supplied and the full checklist is completed, `docs/deployment/production-verification.md` must remain `NOT_EXECUTED`.

## Review Handoff

Review the entrypoint explicit-command routing and production-only preflight order first, then the grant interpretation, controlled-error redaction, HTTP-success cleanup state transitions, exact-ID cleanup, WebSocket-only join acknowledgement, strict record formatter, and runbook stop conditions. Independent reviewer dispatch was not performed here because the controller explicitly prohibited spawning subagents; the controller should arrange the required independent review before integration.
