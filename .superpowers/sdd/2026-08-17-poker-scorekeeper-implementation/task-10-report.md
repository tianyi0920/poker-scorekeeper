# Task 10 Report: Settlement Draft, Editor Lease, and Live Preview

## Status

Implemented on `codex/poker-task10` from base `eed314546d1a41e06af9fcadad6ef63ecf9e0a61` in the isolated `poker-task10` worktree. No merge, push, database reset, or production-database operation was performed.

## Delivered behavior

- Creates exactly one default settlement draft in the same transaction as the `ACTIVE -> SETTLING` transition. The draft starts at version 1 with blank cash-outs, room fee 380 yuan, other fee 0, and a five-minute editor lease owned by the initiating administrator.
- Exposes authenticated draft read and preview endpoints, while restricting save and takeover to current `ADMIN` or `SUPER_ADMIN` users. Demoted actors are rejected by a transaction-time role recheck, and a demoted editor is not reported as editable.
- Saves drafts with optimistic version checks and editor ownership checks. Version/editor conflicts return the latest safe draft representation in error details.
- Allows another administrator to take over only after lease expiry. Save and takeover serialize with game lock, draft lock, then ordered current-user lock/read.
- Builds partial live previews from the append-only buy-in ledger. Entered players immediately show raw table profit; incomplete or unbalanced drafts return stable validation codes instead of fabricated final settlement values.
- On the first complete balanced transition only, independently defaults each non-zero fee payer list that is still empty to the highest raw-profit player, with seat order as the deterministic tie-break. Later explicit empty selections remain empty and validate as such.
- Uses the current system rake rule and current per-user rake flags for every preview, as required by the no-snapshot decision. All request and derived money values are checked against signed `BIGINT` boundaries and serialized through `MoneyJson` strings.
- Writes draft-update and takeover audit rows inside the business transaction. Realtime publication happens after commit through the existing committed-game boundary; publication rejection is swallowed only after the business commit, so it cannot roll back the saved draft or audit row.

## RED -> GREEN evidence

- Contracts: first focused run failed 4/4 because draft schemas did not exist; implementation made the focused contract suite green. Adding response-schema coverage produced one new RED before the DTO schemas were implemented.
- API route: the first focused E2E request expected HTTP 200 and received 404; controller/module/service implementation made it green.
- Current-role presentation: a focused demoted-editor test received `canEdit: true`; adding the current-role gate made the exact test green.
- Existing avatar concurrency test stability: the full suite exposed a handled-too-late rejection (`FORBIDDEN`) as an unhandled rejection. A temporary 100 ms delay reproduced the failure in isolation. The final minimal test-only fix attaches a fulfillment/rejection outcome handler immediately when the promise is created, then still precisely asserts rejected status and `FORBIDDEN`. The temporary delay was removed. No business assertion was relaxed and no rejection is swallowed.
- Lease integration: one test exceeded its five-second budget because it chained two independent real-database scenarios. It was split into focused post-commit visibility and broadcast-rejection durability cases; production behavior and global timeout were unchanged.

## Verification

All commands below were run from the isolated Task 10 worktree after the final production and test changes.

- `pnpm test`: 361/361 passed (contracts 35/35, web 55/55, settlement 14/14, API 257/257), with zero unhandled errors.
- Task 10 E2E: 12/12 passed.
- Task 10 lease/concurrency integration: 5/5 passed.
- Full API integration matrix: 36/36 passed across 6 files.
- Settlement preview mapper: 5/5 passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed, including API build and web/PWA production build.
- `git diff --check`: passed.
- Post-run read-only database audit, after an exact `poker_scorekeeper_test` assertion: `openTransactions=0`, `task10Users=0`, `task10Games=0`.

The first attempted full integration invocation omitted shell injection of `DATABASE_URL`; the schema integration file failed locally at URL parsing before opening a database connection, while the other assertions passed. The corrected invocation loaded the ignored local environment value without printing it, asserted the exact test database name, and then produced the 36/36 result above.

## Concurrency and transaction coverage

- Real-database tests cover simultaneous same-version saves, expired-lease takeover races, save-versus-takeover ordering, transaction-time actor demotion, current committed values after locks, audit durability, post-commit publication visibility, and publication-failure isolation.
- Fixtures use random strict Task 10 prefixes and scoped dependency-aware cleanup. No broad cleanup or reset is used.

## Follow-up boundary

Task 11 finalization must lock and re-read the draft, settings, players/users, and relevant versions in its own transaction before persisting the immutable settlement. Task 10 deliberately does not snapshot rake settings because the approved specification says rule and user flags take effect immediately. Realtime delivery remains best-effort after commit; clients recover through the existing snapshot/reconnect path.

## Independent code review

An independent read-only review found no high-, medium-, or low-severity issues. It confirmed the authorization recheck, lock/CAS protocol, lease transitions, transactional audit, post-commit publication boundary, ledger folding, 12-player limit, and signed-money handling. Residual operational risks are that the reused `game.updated` event is an invalidation signal rather than a draft payload, publication failures are silently isolated without retry, and lease expiry uses application-server time. These are acceptable for the approved single-NAS deployment and existing reconnect/snapshot recovery model.
