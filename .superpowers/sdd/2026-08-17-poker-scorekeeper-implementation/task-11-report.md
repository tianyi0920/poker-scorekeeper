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
