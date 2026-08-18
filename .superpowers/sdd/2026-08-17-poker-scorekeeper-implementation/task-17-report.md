# Task 17 Report — Production Hardening and Synology Deployment

## Status

Complete on isolated branch `codex/poker-deployment`. The branch contains checkpoint commit `e2da464`, merge commit `f140ecd` (which makes `4a6b073` an ancestor), the original Task 17 implementation `a525cd9`, and an independent review-fix commit containing this updated report. Nothing was pushed or merged to the main worktree.

No command connected to, queried, migrated, reset, or cleaned `tianyi.wiki:8306` or `192.168.10.248:3306`. Prisma generation/diff used only the non-connecting placeholder URL `127.0.0.1`.

## Delivered

- Stable HTTP error envelope `{ code, message, requestId, details? }` with controlled Prisma unique, transaction/deadlock, and database-unavailable mappings. Raw exception messages, SQL, stacks, and secrets are not sent to clients.
- Validated request IDs, one-hop production proxy trust, source-IP logging, 2 KiB request-target limit, 256 KiB JSON limit, 64 KiB URL-encoded and Socket.IO limits, existing 5 MiB avatar limit, and unchanged login limiter.
- Same-origin Helmet CSP with exact configured WebSocket origins, frame denial, nosniff, HSTS in production, referrer/permissions policy, and recursive structured log redaction for credentials, database URLs, tokens, cookies, and SQL text.
- Database-independent liveness and bounded readiness. Readiness returns controlled HTTP 503 `DATABASE_UNAVAILABLE` on database failure or timeout.
- Safe same-origin delivery for the built PWA, API, Socket.IO, preset avatars, and controlled uploaded `.webp` files. Reserved paths never fall through to the SPA. Traversal-shaped, dotfile, uncontrolled-name, and symlink file targets are rejected. PWA worker/manifest files remain revalidatable while hashed assets are immutable.
- Node 24 multi-stage Dockerfile with frozen pnpm 10.15.1 install, production-only runtime dependencies, non-root runtime, Prisma generated client/migrations, web dist, backup tools, Tini, health check, and migrate-before-server entrypoint.
- Production Compose contains only the app, binds `127.0.0.1:3000`, publishes no MySQL port, persists avatars/backups/restore staging, uses read-only root filesystem, drops capabilities, and rotates logs.
- Test Compose uses its own MySQL 8.4 service, internal network and named volumes, publishes no MySQL port, and only names `poker_scorekeeper_test`; it contains no user-owned remote database host.
- Fail-closed backup and restore scripts: single-transaction dump, avatar archive, manifest/checksum set, checksum-last publication, exact-pattern 14-day retention, canonical directory guards, double restore confirmation, non-existing isolated target schema, exact checksum filenames, archive traversal/link/special-file rejection, empty avatar target, and cleanup of failed imports.
- Chinese Synology deployment and backup/restore guides covering Container Manager, volume ownership, HTTPS/WebSocket reverse proxy, HSTS, WAN forwarding, migrations, daily backup scheduling, isolated restore drills, upgrade, rollback, and credential rotation.
- Production dependency audit remediation: `sharp` 0.35.3 and a workspace override to `deepmerge-ts` 8.0.1 because current Prisma 7.9.1 still declares vulnerable 7.1.5. Prisma config generation and schema diff were explicitly verified after the override.

## TDD Evidence

- Security/readiness/logger tests initially failed because the hardening modules and endpoints did not exist; focused suites are green after minimal implementation.
- Deployment artifact policy: RED 6/6 on missing Docker/Compose/docs artifacts, then GREEN 6/6.
- Backup/restore behavior was exercised only with temporary directories and fake `mysql`, `mysqldump`, `tar`, `gzip`, and `sha256sum` commands. It reached GREEN 26/26. Dedicated RED cases reproduced checksum-manifest aliases, concurrent publication races, input swaps, archive limits, uncertain database creation, cleanup failure, and termination after avatar publication.
- PWA cache test reproduced the year-long immutable service-worker response; cache policy now revalidates non-hashed PWA files.
- Structured logger test reproduced unredacted SQL-like diagnostics; recursive SQL-text sanitization now covers message and context values.
- The inherited GamePage join-ack test failed repeatedly under the full Web suite. Root cause was its wait ending after socket emission but before the failed-ack React state/effect installed the fallback timer. The test now waits for the observed failed-sync state before advancing fake time; product logic was not changed.

## Review Round 1 Fixes (2026-08-19)

- Restore now snapshots every input into a private workspace before validation/use, verifies the exact versioned manifest schema, checksum names, gzip stream, archive paths/types/counts and compressed/expanded limits before creating a database, and cleans both the newly-created schema and validated restore target on failure or signal. Compose mounts the writable restore parent rather than the atomic publication target.
- Backup publication is serialized per canonical directory, uses checksum-last/no-clobber publication and a monotonic latest marker, and only retains exact numeric-basename artifacts. Database dump happens before the archive; the archive includes only controlled committed direct-child avatar filenames. Uploaded avatar files are append-only so the dump cannot reference a file deleted before archiving.
- Malformed body-parser errors now have controlled 400/413/415 mappings without trusting arbitrary `status` values. Helmet runs before request-target rejection, and decoded mixed-case API, Socket.IO and avatar namespaces never receive the SPA fallback.
- Readiness uses a dedicated MariaDB probe with bounded connection/socket/query timeouts and explicit connection disposal; it no longer leaves a losing Prisma query running after a `Promise.race` timeout.
- Uploaded avatar serving opens the exact direct-child file once with `O_NOFOLLOW`, then uses the same handle for `fstat` and read. Docker uses `tini -g`; the entrypoint forwards termination to an in-flight migration and preserves migration failures before `exec`-ing the API.
- The Chinese restore guide now uses a one-time, exact-target-schema restore account in a mode-600 env file and documents success/failure checks, revocation, user removal, and credential-file deletion.

## Verification

- `@poker/contracts`: 53/53 tests passed.
- `@poker/settlement`: 14/14 tests passed.
- `@poker/web`: 125/125 tests passed; focused GamePage 13/13 passed.
- API pure unit/static/script suites: 137 passed, with one Windows-only skip for the Linux `O_NOFOLLOW` symlink behavior; the same-handle/flag contract is covered by a platform-neutral fake.
- Security/readiness E2E: 22/22 passed, including raw malformed JSON/urlencoded requests and repeated readiness timeouts.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed.
- `pnpm audit --prod --audit-level high`: `No known vulnerabilities found`.
- pnpm 10.15.1 `install --frozen-lockfile`: passed against the final lockfile and override.
- Production-only dependency install: Prisma CLI loaded, compiled API entry imported, and workspace production packages resolved.
- Prisma `generate` and database-free `migrate diff`: passed with `deepmerge-ts` 8.0.1.
- Sharp WebP transform: passed with 0.35.3.
- GNU Bash 5.2 syntax checks for entrypoint/backup/restore and `node --check` for compiled API entry: passed.
- `git diff --check` and deployment secret/placeholder assertions: passed.

## Concerns / Environment Limits

- Docker CLI/daemon and Buildx are not installed in this environment. Real `docker compose config`, image build, multi-stage Linux dependency install, container health smoke, migration-on-start, and named-volume persistence were not run. YAML/Dockerfile policies and pnpm 10 production dependency behavior were verified statically/locally, but a Linux Docker smoke on the Synology or another Docker host remains mandatory before production.
- `shellcheck` is unavailable. Bash parsing and destructive-path behavior tests passed, but ShellCheck itself was not run.
- Database-backed API E2E suites were not run because the authorized remote test database is owned by another task and local Docker is unavailable. Focused hardening E2E uses injected fakes and no database. Run the repository's database integration suites only against a new isolated local Compose project or after the controller explicitly releases the authorized test schema.
- The real Linux `O_NOFOLLOW` symlink test is skipped on Windows because Node does not expose that flag on this platform. Production is the Debian Linux image; the open-once/fstat/read contract and flag request are otherwise covered by unit tests, and the Linux container smoke must exercise the real symlink case.
- The `deepmerge-ts` 8.0.1 override crosses a transitive major version because Prisma 7.9.1 has not yet published a patched declaration. Current Prisma generate/config/diff behavior passes; retain the audit gate and remove the override once Prisma officially adopts 8.x.

## Review Handoff

Review the single-container runtime layout, Linux-native Sharp/Argon2 availability, Prisma migration entrypoint, Compose loopback binding, restore cleanup traps, and the transitive override first. The controller should run the requested independent review before merging.
