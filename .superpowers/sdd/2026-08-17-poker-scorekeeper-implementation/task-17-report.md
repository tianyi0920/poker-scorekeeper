# Task 17 Report — Production Hardening and Synology Deployment

## Status

Complete on isolated branch `codex/poker-deployment`. The branch contains checkpoint commit `e2da464`, merge commit `f140ecd` (which makes `4a6b073` an ancestor), the original Task 17 implementation `a525cd9`, and independent review-fix commits containing this updated report. Nothing was pushed or merged to the main worktree.

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

## Review Round 2 Fixes (2026-08-19)

- Restore input snapshotting moved to a Node 24 guard that opens with `O_NOFOLLOW|O_NONBLOCK`, validates the same descriptor with `fstat`, copies to an exclusive private target with an initial and in-stream size cap, and rejects links, devices, FIFOs, oversized files, or growth. Manifest/checksum snapshots are fixed at 64 KiB; compressed and expanded SQL have separate bounds.
- Avatar archive validation now streams gzip and USTAR headers directly. It verifies checksums, terminators, entry types, direct controlled names, duplicates, path length, entry count, single-file bytes, total bytes and an overall expanded envelope without materializing untrusted `tar -t` output. Handcrafted adversarial headers and a real host-tar USTAR archive are covered.
- Restore owns a database only after `CREATE DATABASE` returns success. An atomic restore-parent lock and unique marker inside the staged avatar tree let signal cleanup distinguish this run's published target from an external writer; tests cover CREATE existence races, an external write between empty-check/rmdir, TERM after rmdir and TERM immediately after move.
- Readiness removed the driver-specific `queryTimeout` option and now destroys a dedicated connection with its own bounded timer when a query never settles. Repeated hung probes leave no pending fake connection. Prisma and readiness share one URL builder for MySQL/MariaDB, bracket-free IPv6, percent credentials and Prisma TLS parameters. Certificate/PKCS12 files resolve relative to the Prisma directory, errors hide paths, and `sslaccept` follows the [official Prisma MySQL URL semantics](https://www.prisma.io/docs/orm/v6/overview/databases/mysql); the connector mapping uses `ca`, `pfx`, `passphrase` and `rejectUnauthorized` as documented by [MariaDB Connector/Node.js](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options).
- Malformed percent escapes and invalid encoded UTF-8 are classified as blocked before SPA fallback. Valid encoded/mixed-case API, Socket.IO and avatar namespaces remain reserved, while normal encoded Unicode SPA routes still work.
- Backup adds `--skip-add-locks` alongside single-transaction/skip-lock-tables, so the isolated restore account does not need `LOCK TABLES`. The Chinese runbooks document the new resource limits, restore lock recovery, ownership marker, expanded-SQL limit and exact privilege rationale.

Round 2 TDD evidence: the focused restore/backup group first failed 7 review behaviors, readiness/TLS failed 4, and malformed-path E2E failed 3. Final focused suites passed backup/restore 31/31, input guard/readiness/Prisma 14/14, and security/readiness E2E 29/29.

## Verification

- `@poker/contracts`: 53/53 tests passed.
- `@poker/settlement`: 14/14 tests passed.
- `@poker/web`: 125/125 tests passed; focused GamePage 13/13 passed.
- API pure unit/static/script suites: 151 passed, with one Windows-only skip for the Linux avatar-serving `O_NOFOLLOW` symlink behavior; restore input descriptor behavior is covered separately by the cross-platform guard suite.
- Security/readiness E2E: 29/29 passed, including raw malformed JSON/urlencoded requests, malformed/encoded namespace paths, and repeated readiness timeouts.
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
- This Windows host provides bsdtar 3.8 rather than GNU tar. The streaming parser accepted a real host-generated USTAR archive and adversarial handcrafted headers; the production Debian GNU tar create/extract round trip remains part of the required Docker smoke.
- Database-backed API E2E suites were not run because the authorized remote test database is owned by another task and local Docker is unavailable. Focused hardening E2E uses injected fakes and no database. Run the repository's database integration suites only against a new isolated local Compose project or after the controller explicitly releases the authorized test schema.
- The real Linux `O_NOFOLLOW` symlink test is skipped on Windows because Node does not expose that flag on this platform. Production is the Debian Linux image; the open-once/fstat/read contract and flag request are otherwise covered by unit tests, and the Linux container smoke must exercise the real symlink case.
- The `deepmerge-ts` 8.0.1 override crosses a transitive major version because Prisma 7.9.1 has not yet published a patched declaration. Current Prisma generate/config/diff behavior passes; retain the audit gate and remove the override once Prisma officially adopts 8.x.

## Review Handoff

Review the single-container runtime layout, Linux-native Sharp/Argon2 availability, Prisma migration entrypoint, Compose loopback binding, restore cleanup traps, and the transitive override first. The controller should run the requested independent review before merging.
