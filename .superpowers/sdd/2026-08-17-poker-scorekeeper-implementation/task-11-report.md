# Task 11 report

- Implemented server-signed confirmation tokens bound to game, canonical saved draft payload/version, settings version, and current player rake flags; production configuration fails closed without a signing secret.
- Added serializable, retry-bounded finalization with the required lock order, permanent result/allocation persistence, completion transition, active-lock release, audit, and best-effort post-commit broadcast.
- Added immutable history list/detail with USER participant scope, administrator scope, capped cursor pagination, and snapshot player identities.
- Focused finalization/history E2E: 6 tests passed. Direct MariaDB serializable duplicate-submit integration: 1 test passed.
- Root lint, typecheck, build, Prisma validate, and migration status passed. Root test suite was started but stopped after existing shared-database `games.e2e` conflicts; Task 11 focused tests are green.

## Continuation completion (2026-08-18)

### Changes completed

- Expanded `settlement-concurrency.integration-spec.ts` to eight real MariaDB cases covering authorization after lock wait, committed lease takeover, settings and participant-rake drift after preview, bounded whole-transaction `P2034` retry (success on attempt three and exhaustion after three), late injected audit failure rollback, and duplicate finalization with exactly one winner plus deterministic `GAME_STATE_CONFLICT` for the loser.
- Replaced the imported/monolithic history coverage with four standalone E2E cases for administrator-global scope, participant-only ordinary-user scope with full-table detail, default limit 10, cap 50, stable `completedAt DESC, id DESC` opaque cursor pagination across tied timestamps without duplicate/gap, immutable financial/timing/player/note/settler fields, and malformed versus canonical-missing identifiers.
- Added `Settlement.settledByNicknameSnapshot`, migration `20260818000100_settlement_settler_snapshot`, atomic persistence of the locked actor nickname, and history reads from that snapshot instead of the mutable `users.nickname` relation.
- Corrected the finalization history missing-ID fixture to a valid canonical nonexistent ID. Raised only the multi-request guard E2E timeout to 30 seconds after its measured whole-suite runtime exceeded the global 15-second default; production timeout/retry behavior was not changed.

### TDD and debugging evidence

- The eight new concurrency tests passed immediately against the existing finalization implementation (8/8). This is recorded as characterization evidence; production concurrency code was not changed merely to manufacture RED.
- History immutability produced a real RED after changing the settler's live nickname: the new history case expected the pre-change nickname snapshot but received the mutated nickname (1 failed, 3 passed). The minimal GREEN was the settlement nickname snapshot column/migration plus persistence/read mapping; focused finalization and history then passed 10/10.
- The first whole-repository run after the history GREEN reported API 282/284: one shared-database active-limit conflict and the multi-request finalization guard at 15.87 seconds. Focused diagnosis showed the guard normally completed in 7-9 seconds; after the per-test 30-second timeout change it passed in focused verification and later in the fresh whole-repository run (about 9.1 seconds).
- Shared-database inspection was preceded by parsing and hard-asserting the exact database name `poker_scorekeeper_test`. Inspection found zero open transactions and two non-Task-11 nonterminal fixtures: `games-824a8f1a1d-private-draft` (`DRAFT`) and `settlement-draft-f8926cd488-demoted-editor` (`ACTIVE`). Their strict prefixes/ownership do not prove Task 11 ownership, so neither was modified or deleted.

### Fresh verification evidence

- Focused finalization plus standalone history: 10/10 passed (finalization 6, history 4).
- Task 11 settlement concurrency integration: 8/8 passed.
- All API integration: 43/44 passed. The sole failure was the existing simultaneous-start expectation receiving zero successes because the unrelated `ACTIVE` fixture already consumed a global active-game slot; all Task 11 integration cases passed.
- Fresh root `pnpm test`: 433/434 passed — contracts 48/48, settlement 14/14, web 88/88, API 283/284. The sole failure was `games.e2e` duplicate-name expecting `ACTIVE_GAME_NAME_TAKEN` but receiving `ACTIVE_GAME_LIMIT` from the same unrelated `ACTIVE` fixture. Task 11 finalization 6/6 and standalone history 4/4 passed under full-suite load; no unhandled rejection was reported.
- Fresh root `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed.
- Prisma `validate` and `migrate status`: passed/current after exact test-database assertion.
- `git diff --cached --check`: passed. High-confidence staged secret scan: zero matches. `.env.local`: ignored and untracked.
- Final post-run database check: exact test database asserted, zero open transactions, zero Task 11 users, zero Task 11 games, and zero Task 11 settlements. The two unrelated nonterminal fixtures above remain untouched.

### Self-review

- Reviewed the complete staged diff, including the nullable/backfill/NOT NULL migration sequence, snapshot write/read path, standalone fixture cleanup, transaction-failure assertions, bounded retry assertions, and duplicate-finalization assertions. No additional Task 11 defect was found.
- The remaining whole-repository failure is an external shared-test-database state concern. Clearing it would violate the explicit ownership boundary, so delivery is `DONE_WITH_CONCERNS` rather than concealing it with a broad cleanup.

## Follow-up closure (2026-08-18)

### Exact fixture ownership and cleanup

- After a fresh exact-name assertion of `poker_scorekeeper_test`, the two blockers were traced directly to source fixtures: `settlement-draft-f8926cd488-demoted-editor` in `settlement-draft.e2e-spec.ts` and `games-824a8f1a1d-private-draft` in `games.e2e-spec.ts`. A read-only relationship-closure audit also found three same-run terminal games explicitly created by `games.e2e-spec.ts`: `games-824a8f1a1d-unplayed-completed`, `games-824a8f1a1d-unplayed-voided`, and `games-824a8f1a1d-played-completed`. The only orphan audit was `GAME_DRAFT_DELETED` by `games-824a8f1a1d-admin`, with matching run metadata. All createdBy/player/event/lock/draft/settlement/audit/session and reverse-user references closed to those strict run IDs; no unrelated reference was present.
- One FK-reverse transaction deleted exactly: settlement results 0, fee allocations 0, audits 1, sessions 6, settlements 0, drafts 0, buy-in events 3, active locks 3, game players 4, games 5, and users 8. No `startsWith` deletion, reset, or unrelated cleanup was used.
- A default-five-second integration timeout later left one source-pattern `prisma-schema.integration-spec.ts` fixture (`settlement test`, suffix `1787036516355s`). Its closure was exactly one user/game/player/settlement/result/allocation and zero event/lock/draft/audit/session rows. A guarded FK-reverse transaction deleted one allocation, result, settlement, player, game, and user.
- The final post-suite audit found only the exact source fixtures `games-d79bf8a662-{super,admin,user}`. Their complete reverse graph contained exactly three authentication sessions and zero created-user/settings/game/player/lock/event/draft/settlement/audit references. A guarded transaction deleted exactly three sessions and three users by their resolved IDs.

### Timeout root cause and minimal test-harness changes

- The first clean all-integration run was 40/44: four assertions reached Vitest's default 5-second timeout even though the API's main test config already allowed 15 seconds. `vitest.integration.config.ts` had omitted `testTimeout`; adding the same 15-second test-only value produced a fresh 44/44 pass (7/7 files), including Task 11 concurrency 8/8 and games concurrency 6/6. The longest observed integration case was about 9.36 seconds. No production timeout or retry behavior changed.
- The first fresh root run after database closure was 432/434. Both failures were only the two multi-transaction settlement-draft cases reaching the main 15-second limit (16.144 and 15.693 seconds); all assertions completed normally when focused.
- Temporary segment instrumentation measured stale-version/takeover at 5.907/7.565 seconds focused and 11.087/10.014 seconds under file load. Individual remote DB/HTTP segments were about 0.04-2.5 seconds. Read-only `processlist`/`innodb_trx` sampling observed at most one normal short transaction, zero lock waits, and no persistent non-Sleep query; an external diagnostic connection once exceeded its one-second socket-connect limit. This supports cumulative remote-database latency variance, not a fixture, pool, or lock leak. All temporary logging was removed, and only those two multi-transaction tests received an evidence-based 30-second test timeout.

### Final fresh verification

- All API integration tests: 44/44 passed (7/7 files).
- Fresh root `pnpm test`: 434/434 passed with zero failures and zero unhandled rejections — contracts 48/48, settlement 14/14, web 88/88, and API 284/284. Settlement draft passed 12/12 under the whole-suite load.
- Fresh root `pnpm lint`, `pnpm typecheck`, and `pnpm build`: passed.
- Prisma `validate` and `migrate status`: passed/current against the hard-asserted `poker_scorekeeper_test` database.
- Final database gate: exact test database, zero open transactions, zero nonterminal games, zero Task 11 fixture games, and zero Task 11 fixture users.

### Final self-review

- Re-read the complete follow-up diff. The durable changes are limited to restoring the integration suite's existing 15-second policy, adding two evidence-scoped 30-second E2E timeouts, and this report. No diagnostic instrumentation, environment value, fixture-cleanup script, production timeout, or unrelated worktree change remains.

## Review fix round 1/5 (2026-08-18)

### Review findings verified and fixed

- History lists now require both `COMPLETED` and an existing permanent settlement before mapping. The new standalone E2E seeds a participant-visible completed game without a settlement and proves both administrator and ordinary-user lists omit it while retaining a valid settled game. RED was a 500 where 200 was expected; focused GREEN was history 5/5.
- Finalization no longer reads `user.rakeEnabled` through the player relation before the explicit user locks. It first locks/loads player and event rows, then locks actor and participant users in sorted ID order, and constructs the confirmation/calculation context only from those current locked user rows. The real MariaDB narrow-window test holds the first sorted user row, starts finalization, waits for the observable InnoDB lock wait, changes another participant through a connection outside the Prisma pool, and proves the stale confirmation is rejected without writes. On the old implementation the early relation read blocked that update until `ER_LOCK_WAIT_TIMEOUT`; after the minimal change the update commits and finalization rejects with `SETTLEMENT_PREVIEW_CONFLICT`. Task 11 concurrency GREEN was 9/9, with the required `system_settings -> game -> draft -> players/events -> sorted users` lock order retained.
- Preview and finalization now share `evaluateSettlement`, including completeness, balance, signed-BIGINT input and derived-output range checks. Invalid previews return `confirmationToken: null`; finalization independently re-evaluates before token verification and returns a stable conflict carrying the validation code. The overflow HTTP RED did not return the required controlled response and instead reached the old persistence path; GREEN proves balanced derived overflow returns 409 `MONEY_OVERFLOW` and leaves settlement, results, allocations, game state, active locks, and audit unchanged. Self-review also found and drove a unit RED for an empty zero-fee table receiving a ready token; the shared evaluator now rejects it as `CASH_OUTS_INCOMPLETE`. Mapper GREEN is 6/6, and the transport contract explicitly accepts the nullable token only on the preview response while finalize input remains non-null.
- The settler-snapshot migration no longer fabricates historical snapshots from mutable current nicknames. A random-name isolated-table integration test executes the actual migration statements under strict MariaDB mode: the old migration produced no error (RED), while the corrected migration fails on nullable-to-NOT-NULL when an old settlement exists and leaves the snapshot null (GREEN 1/1). This project has not had a permanent-settlement release, so empty-database application remains the only accepted path.
- Removed unused `DRAFT_LEASE_EXPIRED` code/message. A repository search found no caller or remaining reference.

### Authorized migration reset

- Immediately before the one authorized reset, the parsed endpoint was hard-asserted as exactly `tianyi.wiki:8306/poker_scorekeeper_test` and the database had zero open transactions. The supplied dangerous-operation consent text was passed only through the required process environment and was not printed.
- Ran `prisma migrate reset --force` exactly once against that asserted test database. It succeeded and reapplied `20260817000100_initial`, `20260817000200_harden_buyin_idempotency`, and corrected `20260818000100_settlement_settler_snapshot`. Final `prisma validate` and `prisma migrate status` both passed; the database reports three migrations and is current.

### Fresh verification and systematic-debugging evidence

- Focused Task 11 finalization: 7/7 passed. Standalone history: 5/5 passed. Task 11 concurrency: 9/9 passed. Migration behavior: 1/1 passed.
- Fresh all API integration: 46/46 passed across 8 files, including concurrency 9/9 and migration behavior 1/1.
- Fresh root `pnpm test`: 437/437 passed with zero failures and zero unhandled rejections — contracts 48/48, settlement 14/14, web 88/88, API 287/287.
- A preceding root run after the empty-table invariant RED/GREEN reached API 284/287: one finalization case and two following setup hooks exceeded their existing 15/10-second test limits while the remote-database suites were globally much slower. Read-only diagnosis found zero open transactions, zero lock waits, zero nonterminal games, and zero Task 11 fixtures. No timeout was widened and no data was cleared; the next clean rerun passed all 437 tests, including finalization 7/7 and history 5/5.
- Fresh root `pnpm lint`, `pnpm typecheck`, and `pnpm build` passed. `git diff --check` passed.
- Final database gate hard-asserted the exact authorized test endpoint and reported zero open transactions, zero lock waits, zero nonterminal games, zero active-player locks, zero Task 11 fixture games/users, and zero migration shadow tables.
- `.env.local` remains ignored and untracked. The staged high-confidence secret scan found no credential material.

### Final self-review

- Re-read the complete production, migration, contract, and test diff. Verified the nullable preview token does not weaken the non-null finalize request, finalization only consumes current locked rake rows, shared invariant/range evaluation precedes confirmation and persistence, history never force-maps a nullable settlement, migration cleanup is exact even on expected failure, and no temporary instrumentation or database-cleanup code remains.

## Review fix round 2/5 (2026-08-18)

### SQL-mode-independent migration guard

- Verified the review finding against the real MariaDB engine and the actual migration SQL rewritten only to random-name shadow objects. With an existing settlement, the old migration succeeded under `sql_mode=''` and coerced the new required column instead of failing closed; under `STRICT_ALL_TABLES` it failed only during the persistent `ALTER` sequence. This was the required RED and proved the old behavior depended on session SQL mode.
- Added a deterministic preflight before either persistent `ALTER`: create a session-temporary guard table, insert one primary-key sentinel, then conditionally insert the same key from `settlements`. Any existing settlement now raises `ER_DUP_ENTRY` before a persistent schema or business-data mutation, independently of SQL mode. The temporary guard is dropped before the normal empty-table migration continues.
- Expanded the behavior integration test to execute the actual migration statements in four real MariaDB cases. Existing-settlement cases in both non-strict and strict modes assert `ER_DUP_ENTRY`, the unchanged original two-column schema, and unchanged row data. Empty-table cases in both modes assert successful migration and `settled_by_nickname_snapshot` as `NOT NULL`. Each case restores the original session mode and removes its exact temporary/shadow objects in `finally`. Focused GREEN: 4/4.

### Authorized reset and migration verification

- Immediately before the single authorized reset for this round, the parsed endpoint was hard-asserted as exactly `tianyi.wiki:8306/poker_scorekeeper_test`; the read-only preflight found zero open transactions. The user's exact dangerous-operation consent text was supplied only through the required process environment and was not printed.
- `prisma migrate reset --force` ran exactly once against that asserted test database and successfully replayed all three migrations, including the corrected settler-snapshot migration. The post-reset focused migration behavior test passed 4/4. Final Prisma `validate` passed and `migrate status` reports all three migrations current.

### Fresh verification and remote-database evidence

- Fresh all API integration: 49/49 passed across 8 files, including Task 11 concurrency 9/9 and migration behavior 4/4.
- The first fresh root `pnpm test` completed 433/437 with four API failures: a buy-in multi-request case at 15.452 seconds, a realtime event wait timeout followed by a dependent 500, and the duplicate-finalization case at 17.926 seconds; the timed-out realtime promise also produced one unhandled rejection. API duration was 587.49 seconds. A read-only exact-database audit immediately afterward found zero open transactions, lock waits, active queries, nonterminal games, active-player locks, Task 11 fixtures, failed-suite fixtures, and migration shadow objects.
- Per controller direction, exactly one clean root rerun was made after that clean audit. It completed 412 passed, 2 failed, and 23 skipped out of 437 tests. The first suite error was Prisma's transaction/pool acquisition deadline during `BootstrapAdminService` (`pool timeout` after about 10 seconds, `active=0 idle=0 limit=3`), and its exact cleanup query hit the same empty-pool deadline. The two counted failures were a settlement-draft test at 16.54 seconds and its following dependent request returning 500. In the same run, realtime passed 31/31 but took 177.096 seconds, finalization passed 7/7, and the API suite took 619.18 seconds. This directly identifies remote connection acquisition/cumulative latency rather than a lock or fixture leak.
- The second post-failure read-only audit again hard-asserted the exact endpoint and found zero open transactions, lock waits, active queries, nonterminal games, active-player locks, Task 11 game fixtures, failed-suite fixtures, and migration shadow objects. The final user-fixture gate separately found the exact orphan `history-cdd5af91-bootstrap`. Source inspection tied it to `history.e2e-spec.ts`; a read-only closure audit proved zero game, player, event, session, audit, or active-lock references. A guarded transaction deleted exactly that one user by full ID and username. No unrelated data was cleared, no timeout was widened, and no third root rerun was used to conceal the environmental failure.
- Fresh root `pnpm lint`, environment-loaded `pnpm typecheck`, and `pnpm build` passed. The first typecheck invocation stopped before typechecking because Prisma config had not been given `DATABASE_URL`; rerunning with the existing ignored test environment loaded passed completely without printing environment values.

### Final self-review and disposition

- Re-read the complete round-2 diff. The migration now fails before persistent changes for every non-empty settlement table, the empty-table path remains replayable, the behavior test drives the actual SQL under both required modes, session state and exact test objects are cleaned in `finally`, and no production timeout, broad cleanup, diagnostic instrumentation, or environment value was added.
- The requested migration fix and all scoped/fresh integration and static gates are green. The only incomplete gate is a green full root test run, blocked twice by the remote test database's measured connection-pool/latency behavior with clean transaction, lock, and fixture audits. Delivery is therefore `DONE_WITH_CONCERNS`; the controller will perform the final independent full-repository gate after the remote connection cools.

## Verification stabilization (2026-08-18)

### RED evidence and timeout policy

- The controller's independent run at `d673984` passed contracts 48/48, settlement 14/14, and web 88/88; API was 284/287 over 628 seconds. The only failures were the games snapshot-visibility test at 15 seconds, the finalization happy path at 19.352 seconds, and the following finalization `beforeEach` at 10 seconds after the preceding timeout. There was no semantic assertion failure.
- A first minimal experiment gave only those two tests and the finalization `beforeEach` a 30-second budget. Focused games/finalization passed 30/30, but the one permitted fresh root run degraded across unrelated suites: API 279/287 over 705.85 seconds, with eight 10-21-second timing failures and one delayed realtime rejection. The two requested target tests passed (snapshot visibility 16.330 seconds; happy finalization 7.615 seconds). Exact-database read-only audits before and after found zero open transactions, lock waits, active queries, nonterminal games, active locks, related games, or related users.
- Because five unrelated remote-DB E2E suites crossed their prior local budgets without transaction, lock, or fixture residue, the controller replaced per-test chasing with one test-harness policy: API E2E `vitest.config.ts` now uses `testTimeout: 30_000` and `hookTimeout: 30_000`. The three experimental local timeout arguments were fully reverted. Production code and the separate integration configuration (15 seconds) remain unchanged.

### Focused connection failure and cleanup hardening

- The first five-file focused run under the unified policy passed realtime 31/31, settlement draft 12/12, buy-ins 23/23, and games 23/23. Finalization did not start its seven tests because `BootstrapAdminService` could not acquire a Prisma transaction during `beforeAll`; this was an internal connection deadline, not a 30-second Vitest timeout or business assertion. The immediately following one-second diagnostic connection also timed out creating its socket; a read-only audit with a diagnostic ten-second connect allowance then proved zero transactions, locks, active queries, nonterminal games, active locks, games, and related users.
- That initialization failure also exposed an independent teardown defect: `afterAll` dereferenced `originalSettings` even though `beforeAll` had not assigned it, obscuring the original acquisition error with a `TypeError`. The cleanup now restores settings only when the snapshot was captured, while still attempting owned-game/user cleanup and closing any created app; it does not swallow the original initialization failure or change production connection behavior.

### Driver and interactive-transaction root cause

- A root run using only the unified Vitest budget completed 418 passed, two failed, and 17 skipped out of the then-current 437 tests, with zero unhandled rejections. The two assertions were login requests returning 500 in realtime and users; avatars could not start because `BootstrapAdminService` hit the Prisma transaction-acquisition deadline. There was no 30-second Vitest timeout, and all five target suites passed in that run. The exact-database post-run audit again found zero transactions, lock waits, active queries, games, active locks, or relevant fixture users.
- Installed `mariadb@3.5.3` source confirms driver defaults of one second for socket connection and ten seconds for pool acquisition. Its unset `minimumIdle` becomes `connectionLimit`, so the test pool attempted to maintain three connections; pool construction starts that work immediately and creates them serially. This matches the observed one-second diagnostic socket failures, ten-second successful diagnostics, and empty `active=0 idle=0 limit=3` pool errors.
- The configuration-policy unit test first failed 2/2 because no exported policy existed. The initial GREEN set only test-mode adapter `connectTimeout: 10_000` and `acquireTimeout: 30_000`, retaining pool limit 3 and production defaults. A five-file focused run then passed 95/96: one settlement-draft `beginSettlement` returned 500. One temporary, sanitized focused diagnostic identified `PrismaClientKnownRequestError` `P2028` after the interactive transaction had started and completed every mutation through the audit write; it failed at the final snapshot query after 9.269 seconds. Thus this failure was transaction expiry, not login, pool acquisition, max-wait, query lock, or broadcast. Temporary logging was fully removed, and pre/post diagnostics found zero transactions, lock waits, games, active locks, or draft fixture users.
- The second configuration RED failed on the missing test `minimumIdle` and transaction policy. The final test-only policy is pool limit 3, minimum idle 1, connect timeout 10 seconds, acquire timeout 30 seconds, Prisma transaction max-wait 15 seconds, and Prisma transaction timeout 20 seconds. Production still sets only its existing pool limit 10 and does not override driver or Prisma timeout/minimum-idle defaults. Pure policy GREEN is 3/3 and contains no real URL or credential.

### Final fresh verification

- The previously failing empty-payer settlement-draft case changed from `P2028` to 1/1 GREEN (24.072 seconds focused), preserving the successful atomic transition and draft update. The subsequent five-file focused run passed 96/96 with zero failures and zero unhandled rejections: realtime 31/31, finalization 7/7, settlement draft 12/12, buy-ins 23/23, and games 23/23.
- The one permitted fresh root `pnpm test` passed 440/440 with zero failures, skips, or unhandled rejections: contracts 48/48, settlement 14/14, web 88/88, and API 290/290. The three new configuration-policy tests account for the increase from 437 to 440. API duration was 520.97 seconds; there was no `P2028`, HTTP 500, or 30-second timeout.
- Fresh root `pnpm lint`, environment-loaded `pnpm typecheck`, and `pnpm build` passed. The first post-change typecheck exposed only a compile-time `PoolConfig` mismatch between the workspace's MariaDB 3.5.3 and the adapter's MariaDB 3.4.5; deriving the type from `PrismaMariaDb`'s constructor removed that cross-version coupling, after which the policy test and full typecheck passed.
- Prisma `validate` passed and `migrate status` reports all three migrations current. `.env.local` remains ignored and untracked; no environment value was printed or added.
- The post-root exact-database audit found one orphan `audit-1f27db7bfa-bootstrap`, directly owned by `user-audit.e2e-spec.ts`. Its full reverse closure had zero created users, settings, games, players, locks, events, drafts, settlements, audits, or sessions. A guarded transaction deleted exactly that one user by full ID and exact username. The final gate hard-asserted `tianyi.wiki:8306/poker_scorekeeper_test` and found zero open transactions, lock waits, active queries, games, nonterminal games, active-player locks, test fixture users, or migration shadow tables.

### Final self-review

- Re-read the complete stabilization diff. Test-only database behavior is isolated behind `NODE_ENV === 'test'`; production retains its original pool limit and all driver/Prisma timeout defaults. The unified Vitest budget applies only to the API E2E/unit configuration, not the 15-second integration configuration or production. No local timeout exception, diagnostic logging, broad cleanup, environment value, or unrelated change remains.

## Stabilization review fix (2026-08-18)

### Review verification and TDD evidence

- Verified both review findings against base `86821fb`. The default API Vitest configuration collected unit/spec and remote-database E2E files under the same 30-second test/hook policy, and finalization teardown awaited database cleanup before `app.close()`, so a cleanup rejection skipped close.
- Config RED: the two policy tests failed because the default config exposed `30_000/30_000` and collected `test/**/*.e2e-spec.ts`, while the E2E config merely re-exported that same mixed configuration. Cleanup RED: an injected cleanup failure left the real `closed` state false. A second cleanup RED proved simultaneous cleanup/close failures surfaced only the close error instead of both failures.
- GREEN: `vitest.config.ts` now collects only `src/**/*.test.ts` and `test/**/*.spec.ts` with the original 15-second test and 10-second hook budgets. The independent `vitest.e2e.config.ts` preserves the same single-fork serial execution but exclusively collects `test/**/*.e2e-spec.ts` with 30-second test/hook budgets. The API `test` script runs these disjoint suites sequentially, while `test:e2e` remains E2E-only. Focused config/cleanup regression verification passed 4/4.
- Finalization teardown now runs cleanup and close through a small test-only helper whose `finally` path always attempts close. One failure is rethrown unchanged; cleanup plus close failures are retained in ordered `AggregateError.errors`. This does not suppress a `beforeAll` failure. Focused finalization E2E passed 7/7 with no warning or unhandled rejection.

### Fresh repository and database verification

- The one permitted fresh root `pnpm test` passed 444/444 with zero failures, skips, or unhandled rejections: contracts 48/48, settlement 14/14, web 88/88, API unit/default 97/97, and API E2E 197/197. The four new regression tests account for the increase from 440 to 444; no existing coverage was removed or duplicated.
- Fresh root `pnpm lint`, environment-loaded `pnpm typecheck`, and `pnpm build` passed. An initial typecheck invocation without the ignored local test environment stopped at Prisma config loading before typechecking; the correctly environment-loaded fresh invocation passed without printing environment values. Prisma `validate` passed and `migrate status` reports all three migrations current on the exact test database.
- The post-root exact endpoint guard confirmed `tianyi.wiki:8306/poker_scorekeeper_test` and initially found zero open transactions, lock waits, active queries, games, nonterminal games, active-player locks, Task 11 fixture users, and migration shadows. One broader E2E orphan, exact user `audit-2004dfd4d4-bootstrap`, was traced directly to `user-audit.e2e-spec.ts`. Its complete reverse closure was zero created users, sessions, settings, created/settled games, players, locks, buy-in events, edited drafts, settlements, and audits. After a repeated exact endpoint/zero-transaction guard, one user was deleted transactionally by its full ID plus full username. The final audit reported zero for every preceding category and for all known E2E fixture-user prefixes.

### Final self-review

- Re-read the complete review-fix diff. Test collection is disjoint and exhaustive, only remote-database E2E receives the 30-second policy, integration remains unchanged, and the test-only database connection/transaction policy from stabilization is untouched. Teardown attempts both cleanup and close and preserves every resulting failure. No production code, local timeout exception, diagnostic logging, broad database cleanup, environment file/value, or unrelated change is included.
