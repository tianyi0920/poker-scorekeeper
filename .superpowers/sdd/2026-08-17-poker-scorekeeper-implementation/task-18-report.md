# Task 18 Report — Mobile E2E, Restore Drill, and Release Verification

## Status

Implementation and all locally executable release gates are complete on `codex/poker-scorekeeper`. The mandatory Docker/image/volume/isolated-restore portion remains blocked because this Windows environment has no Docker CLI, daemon, Buildx, or Compose. `pnpm verify:release` treats that as a release failure; it does not skip or report success.

No command connected to or queried the NAS production database or service. Database-backed local/API/browser verification was guarded before access to the exact authorized `mysql` test target `tianyi.wiki:8306/poker_scorekeeper_test`; credentials were loaded only from ignored `.env.local` and were not logged. No reset or broad cleanup was used.

## Delivered

- Pinned Playwright 1.55.0 with deterministic, single-worker fixture ownership and Chromium/WebKit projects at 360x800 and 430x932.
- Browser coverage for bootstrap/forced-password handling, role denials, two-table and one-player concurrency limits, idempotent purchase and correction chains, settlement lease takeover, live rake changes, balanced finalization, immutable history, all-player aggregation, avatar upload/reset, and app restart recovery.
- A real full-game browser flow in which an administrator starts a table, three accounts buy and correct hands, settlement balances, and a participant sees complete settlement/history aggregation.
- Four real-browser 12-seat mobile checks with populated data, zero horizontal overflow, a visible self seat, every visible button/link at least 44x44 CSS pixels, zero post-login console/page errors, and attached full-page screenshots plus an HTML report under ignored `test-results/`.
- A minimal mobile flex-item sizing correction for long game headings found by the mobile acceptance test.
- A controlled avatar upload interceptor so the real browser path receives the stable `AVATAR_TOO_LARGE` error envelope instead of a framework-specific Multer response.
- Exact run-id database fixtures whose teardown follows the owned game/user reference graph and deletes only those rows and owned upload files. High-volume history setup is limited to batches of three and waits for every promise in a batch to settle before any failure cleanup begins.
- A root `pnpm verify:release` command that requires pnpm 10.15.1, validates the exact test database target, and fails closed across frozen install, typecheck, package/API tests, integration, Playwright, build, Docker CLI/daemon/Buildx/Compose, image build, migration/readiness, restart persistence, backup, isolated restore, restored-history/avatar assertions, and same-image health/avatar serving.
- Restore-drill seed and assertion scripts restricted to a unique Task 18 data marker and the exact new schema `poker_scorekeeper_restore_test`. Test Compose adds a dedicated restore volume. The release cleanup is limited to its randomly named Compose project and volumes.
- Synology documentation now makes the complete release command and its non-optional Docker/restore gates explicit.

## TDD and Debugging Evidence

- The first full-game Playwright scenario was run before deterministic fixtures/selectors/server wiring and failed as expected. After implementing only the required harness and flows, the focused scenario passed in a real browser.
- Mobile acceptance exposed horizontal overflow from the game-heading flex child; the one-line `min-width: 0` correction made all four viewport/browser combinations green.
- The avatar lifecycle exposed Multer's uncontrolled oversize response; a focused interceptor mapping made the real API/browser contract green while retaining the existing byte limit.
- The first expanded API verification encountered genuine remote-test-database latency: connections took about 4.2 seconds and simple queries about 1.9–2.6 seconds. One high-volume fixture also rejected while sibling promises were still using the three-connection pool, so teardown raced live work and temporarily left an owned fixture graph. Batching plus `Promise.allSettled` fixed the lifecycle defect. Only affected hook/test budgets were raised; assertions and production behavior were not weakened.
- A later full release run reached 49/49 passing integration assertions but failed because Vitest caught an expected `FORBIDDEN` rejection before the test attached its matcher. Both analogous game-lifecycle races now attach a fulfilled/rejected normalization handler immediately when the operation starts; the focused integration file then passed 6/6 without `PromiseRejectionHandledWarning` or unhandled errors.
- Final residue review found five local WebP files from prior Task 18 avatar upload/reset runs even though their database users were gone. The application deliberately preserves committed uploads, so teardown now matches only the current run's exact fixture user IDs plus a UUID/WebP filename before unlinking. The five audited files were removed by exact absolute name; a focused avatar run and then the complete 15-test browser suite left zero local fixture avatars.
- After interrupted/failed diagnostic runs, two isolated owned users and a separate eight-user/three-game owned graph were checked by exact IDs/names/references and transactionally removed. Follow-up counts were zero before final verification.

## Verification

- Playwright focused mobile matrix: 4/4 passed on Chromium and WebKit at 360x800 and 430x932.
- Complete Playwright suite: 15/15 passed in the release command (4.5 minutes), then 15/15 after the final cleanup hardening (4.7 minutes). The ignored HTML report contains four PNG mobile screenshots.
- Deployment/release artifact policy: 9/9 passed.
- Contracts 53/53, settlement 14/14, and Web 125/125 passed.
- API unit/static/script gates passed 159 tests with one conditional skip for the inherited Windows-only lack of Linux `O_NOFOLLOW` behavior. Backup/restore behavior tests were 35/35 within that gate.
- API database E2E passed 15/15 files and 233/233 tests. Guarded concurrency/migration integration passed 8/8 files and 49/49 tests without unhandled errors.
- `pnpm typecheck` and `pnpm build` passed.
- The fresh final `pnpm verify:release` exited 1 only at `Get-Command docker` after every preceding gate above passed. It never emitted `release verification passed`.
- Post-run guarded residue probe found zero Task 18 users, games, or audit rows and zero local Task 18 avatar files. Process inspection found zero workspace Node processes and zero listeners on release ports 3000/3001.

## Docker / Backup / Restore Boundary

Read-only capability checks found no Docker CLI, so no daemon, Buildx, or Compose capability was available. Consequently the real Linux image build, Compose migration/readiness, named-volume restart, real `backup.sh`, creation of `poker_scorekeeper_restore_test`, restore, restored-image boot, and restored history/avatar assertions could not be executed. The release script preserves all of these as mandatory gates and stops at missing Docker rather than simulating or skipping them.

No restore schema was created remotely and no privilege expansion was attempted. The authorized remote `_test` schema was never overwritten. Before release, run the unchanged `pnpm verify:release` on a Docker-capable host and require its final `release verification passed` output.

## Review Handoff

Review the fixture ownership predicates, the all-settled batching behavior, the four-project Playwright selection, the avatar error mapping, and the PowerShell-to-Compose argument construction first. The release must remain blocked until a Docker-capable host completes image, migration, restart-volume, backup, and isolated-restore gates.
