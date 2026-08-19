# Task 19 Report — Synology Production Preflight and Live-Acceptance Readiness

## Status

`DONE_WITH_CONCERNS`

All safely executable Task 19 code, tests, documentation, and offline verification are complete on `codex/poker-scorekeeper`. No production deployment or live acceptance was performed. The production record remains explicitly `NOT_EXECUTED`.

Baseline was clean at `0b1cbcf1bc6566e6543752997020c0ec029ea506`. No command connected to, queried, created, migrated, backed up, restored, or modified `192.168.10.248:3306/poker_scorekeeper`. No command used the database password previously exposed in chat, and no credential, Cookie, token, connection URL, or other secret was printed or committed.

## Delivered

- Exact production target validation accepts only MySQL at `192.168.10.248:3306/poker_scorekeeper`; malformed URLs, alternate protocols, implicit/wrong ports, remote-test hosts, and wrong schemas fail with controlled codes that do not reflect input.
- A read-only preflight connects without selecting a possibly absent schema, uses only static `SELECT`, `SHOW GRANTS`, and session-level `USE`, and reports server version, current database, `utf8mb4`, schema existence, creation capability, and use capability. Driver and permission details are replaced with controlled codes; reports never include the password or full connection URL.
- Production database creation reuses the exact target guard before connection on validation and real execution paths, regardless of `NODE_ENV`. The production image entrypoint unconditionally runs the read-only target preflight before any explicit one-off command, migration, or normal API start; no opt-out variable exists in the production image or Compose. The isolated test Compose explicitly replaces the image entrypoint for its internal MySQL-only stack.
- The entrypoint now honors commands supplied by `docker compose run`. This repairs the inherited behavior where the documented preflight command was ignored and the container instead migrated and started the API.
- Reversible public acceptance validates an exact root HTTPS origin, ready health plus HSTS, bootstrap-super-admin login, CSRF, forced password rotation, temporary ordinary-user creation, empty-game creation/start, a WebSocket-only Socket.IO room join with acknowledgement, empty-game void, and temporary-user logical deletion. It never buys chips or creates a financial settlement.
- Acceptance cleanup is limited to IDs proven by exact `Location` headers for this run. Ownership and HTTP-success state are recorded before response-body validation, so truncated JSON still cleans the exact user/game and an ACTIVE game is voided rather than draft-deleted. Missing/unrecognizable ownership fails closed, stops further creation, avoids guessed deletion, and emits only a run marker plus manual-cleanup resource type.
- Login, password change, user create/delete/list readback, game create/start/void, and WSS join acknowledgements are parsed by shared contracts and checked against the exact username, nickname, role, game name, ID, status, and empty-game invariants for this run. Logical deletion additionally requires `isActive=false`, non-null `deletedAt`, and a confirmed list readback.
- `--record` no longer accepts evidence-shaped environment variables. It checks Docker/Compose before acceptance, then collects the real image digest, Prisma migrate status, exact repository/database migration checksums, public HTTPS health/HSTS, and a newly executed/recomputed backup. Only all-PASS evidence can be formatted. Publication uses a same-directory exclusive temporary file, file flush/fsync, and atomic rename; failures remove only the temporary file and preserve the prior record.
- The production checklist and Synology runbook make rotated credentials, independent session/CSRF secrets, the exact HTTPS origin, Docker/Compose capabilities, directory modes, fixed database target, loopback-only port, reverse-proxy/WebSocket/real-IP settings, router TCP 443 boundary, real-phone observation, first backup, and secret-free evidence mandatory.
- `.env.example` now includes the required secret-free `SESSION_SECRET` placeholder. The initial verification document contains no fabricated evidence and remains `NOT_EXECUTED`.

## Task 19 Plan Defect and Ruling

The inherited Docker entrypoint ignored every explicit image command. Therefore the planned command:

```sh
docker compose run --rm app node scripts/database/production-preflight.mjs
```

would not run the preflight. It would execute `prisma migrate deploy` and start the API, causing production mutation before the intended read-only gate. This contradicted the Task 19 order and the explicit fail-closed requirement.

Ruling: explicit commands must be executed by the entrypoint. Every production-image command other than the preflight itself first runs the same read-only exact-target gate; normal startup also gates before migration. The isolated test Compose explicitly replaces the image entrypoint and command for its internal `mysql:3306/poker_scorekeeper_test` flow. This test-only override is not an environment switch and is absent from the production image/Compose configuration.

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

### Review fix round 1 (`136afc0` baseline)

- Entry guard RED: deployment policy failed 3 assertions because the production entrypoint/Compose still depended on `PRODUCTION_TARGET_REQUIRED` and the isolated test Compose had no explicit override; real-Bash explicit-command preflight also failed. The production flag was removed, entry preflight made unconditional, test Compose given an explicit entrypoint replacement, and create-database made target-strict on every path. Focused artifact/entrypoint tests passed 12/12 before the later controller additions and 14/14 in the final focused group.
- Ownership RED: new controller tests observed no `Location` headers. Both create endpoints now return exact `/api/users/{id}` or `/api/games/{id}` locations. Acceptance tests prove truncated user/game 201 bodies still clean only those header-owned IDs; a successful create without recognizable ownership stops immediately, performs no guessed deletion, and carries a secret-free manual-cleanup marker.
- Contract/readback GREEN: all mutating JSON responses use shared strict schemas and exact run-owned identity/status checks. User deletion requires exact ID/username/nickname/role, `isActive=false`, non-null `deletedAt`, and a strict `/api/users` readback. ACTIVE cleanup always uses VOID; draft deletion is limited to the exact Location-owned empty draft.
- Evidence RED: the old formatter failed once migration checksum and explicit acceptance evidence became mandatory, and the old environment-shaped writer failed the new API. `--record` now probes Docker/Compose and the running healthy container/tag digest, reads Prisma status and exact DB/repository checksums, checks public health/HSTS, runs a fixed-target backup and independently recomputes its three checksums, then atomically publishes only all-PASS evidence. Fake-command tests cover real collection boundaries and prove missing Docker stops before acceptance; fake filesystem tests prove write/sync/close/rename order and prior-record preservation on rename failure.
- WSS contract GREEN: `gameJoinAckSchema` is now the sole acknowledgement parser; the focused test rejects an otherwise plausible ack missing `version` and `snapshotSent`.
- A later broad API pure-test invocation accidentally omitted `BASH_PATH`, so shell cases failed only with `spawnSync bash ENOENT`. No code changed for that result; rerunning the same 174-test pure group with the adjacent runtime Bash passed 173 with the single existing Windows `O_NOFOLLOW` skip.

## Verification

All commands used Node 24.19.0 and pnpm 10.15.1. Prisma generation/type/build used only `mysql://build:build@127.0.0.1:3306/poker_scorekeeper_build`, which does not connect.

- Task 19 focused suite: 29/29 passed.
- Production/database safety validation: 6/6 passed.
- Production deployment artifact policy: 9/9 passed.
- Real Bash entrypoint behavior/signal group: 3/3 passed.
- `@poker/contracts`: 53/53 passed.
- `@poker/settlement`: 14/14 passed.
- `@poker/web`: 125/125 passed.
- API pure unit/static/script group: 173 passed, one existing Windows-only `O_NOFOLLOW` test skipped.
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

Round-1 review findings are implemented and locally verified. Re-review the unconditional production entry target gate and isolated-test override; Location-first ownership under truncated bodies; shared contract and logical-delete readback checks; running-container digest/migration/health/backup evidence collection; atomic record publication; and complete WSS join acknowledgement. Independent reviewer dispatch remains the controller's responsibility because this worker was explicitly prohibited from spawning subagents.
