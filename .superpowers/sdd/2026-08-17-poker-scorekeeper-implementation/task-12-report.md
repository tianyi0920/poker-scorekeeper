# Task 12 Report: Authorized Multi-Game All-Player Aggregation

## Change

- Added `POST /api/history/aggregate` for explicit completed-game selections and server-resolved quick filters: recent 10, recent 30, last 30 days, last 90 days, and inclusive custom UTC date ranges.
- Added strict request validation: canonical IDs, unique IDs, an explicit 100-game selection limit, strict body shapes, and validated date ranges.
- Added immutable snapshot aggregation from `settlement_results` plus `game_players` snapshots. Ordinary users must participate in every requested game; any missing, incomplete, or out-of-scope ID rejects the complete request with `403 HISTORY_SCOPE_DENIED`. Administrators retain global completed-history scope.
- Added response contracts, bigint checked component accumulation, deterministic player/per-game ordering, and E2E coverage for precise sums, wins/losses/ties, deleted-user snapshots, filters, validation, and overflow.

## RED evidence

- `pnpm --filter @poker/api test:e2e -- history-aggregation.e2e-spec.ts` was first attempted only after asserting the test database name. Its first environmental failure was that the shell PATH omitted Node for pnpm child scripts; root cause was confirmed from the pnpm launcher and fixed only in the command process by prepending the supplied runtime Node directory.
- With that environment fixed, baseline Nest route mapping contained only `GET /api/history` and `GET /api/history/:gameId`; it did not map `POST /api/history/aggregate`, so the new real HTTP expectations were RED for the missing route.

## GREEN evidence

- `pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/history-aggregation.e2e-spec.ts --silent`: 1 file, 6/6 tests passed.
- `pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/history-aggregation.e2e-spec.ts test/history.e2e-spec.ts --silent`: 2 files, 11/11 tests passed.
- Full API integration suite: 8 files, 49/49 tests passed.
- Root test-equivalent runner (contracts, settlement, web, API unit, then API E2E) exited successfully; final API E2E phase was 13 files, 203/203 tests passed.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` all passed.
- `pnpm --filter @poker/api prisma validate` passed; `pnpm --filter @poker/api prisma migrate status` reported the test schema up to date.

## Database safety

- Every DB command and E2E invocation first parsed `DATABASE_URL` and hard-asserted exactly `poker_scorekeeper_test`; no production host or production database was used.
- Test cleanup was restricted to the run-unique `history-aggregate-*` ownership graph. Post-suite read-only residue check returned `HISTORY_AGGREGATION_FIXTURE_RESIDUE=0`.

## Secret/environment gate

- Diff whitespace check passed.
- Credential-literal scan across all six Task 12 code/test files returned zero hits. A broader heuristic initially matched intentionally runtime-generated test password/CSRF variables; source inspection confirmed no literal credential was present.

## Self review

- Confirmed authorization precedes aggregation and cannot silently filter an explicit out-of-scope ID.
- Confirmed mutable user nickname/avatar fields are not queried for aggregate output; persisted game-player snapshots supply the displayed identity.
- Confirmed money arithmetic uses `bigint`, each accumulated component has signed BIGINT bounds checks, and JSON output uses money strings.
- Confirmed player order is final amount descending then normalized nickname (with user ID only as a deterministic equal-name tie-breaker); per-player game rows follow completed-at/id descending selection order.

## Concerns

- The first complete integration run had 3 failures in the pre-existing Task 11 settlement-concurrency lock/audit test. Evidence showed the standalone file immediately passed 9/9, the database inspection showed no open transaction or pool timeout, and the subsequent full integration rerun passed 49/49. No timeout, connection-pool, or settlement code was changed.

## Commit

- Feature commit: `1f4d50df803ffde67dceaf187fe4ef02ecf22d75` (`feat: add all-player history aggregation`)
