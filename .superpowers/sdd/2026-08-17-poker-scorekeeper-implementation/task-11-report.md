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
