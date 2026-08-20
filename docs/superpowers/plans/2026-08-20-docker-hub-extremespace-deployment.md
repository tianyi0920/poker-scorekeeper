# Docker Hub 多架构发布与极空间部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目构建为公开的 `docker.io/tianyi920/poker-scorekeeper` AMD64/ARM64 固定版本镜像，让极空间 NAS 无需源码构建即可连接现有 MariaDB 部署，同时保留自动迁移、生产目标门禁和完整发布证据。

**Architecture:** 构建阶段继续使用锁定的 pnpm，运行镜像改为直接执行随生产依赖安装的 Prisma CLI。私有 GitHub 仓库通过隔离 MySQL 完成验证，再发布不可变版本标签和提交标签；远端清单验证通过后才提升 `latest`。极空间只保存 registry Compose、环境文件和三个数据目录。

**Tech Stack:** Dockerfile/Buildx/QEMU、Docker Compose、GitHub Actions、Node.js 24、pnpm 10.15.1、Prisma 7、MariaDB/MySQL 8.4、Vitest、Playwright、PowerShell/Bash。

**Spec:** `docs/superpowers/specs/2026-08-20-docker-hub-extremespace-deployment-design.md`

## Global Constraints

- 生产数据库目标固定为 `192.168.10.248:3306/poker_scorekeeper`；任何自动测试只能使用隔离的 `*_test` 数据库。
- 不读取、输出、提交或打包真实数据库密码、Session/CSRF 密钥、Docker Hub token 或 `.env.production`。
- GitHub 仓库创建、Docker Hub 仓库创建、token 创建、Secret 写入、首次 push 和 `v1.0.0` tag push 都是独立外部写入；到达对应步骤时必须再次取得用户授权。
- 固定版本标签不得覆盖。远端状态不明确、网络错误或身份不一致时必须失败关闭。
- 不以删除自动迁移作为 Corepack 问题的修复；运行镜像必须直接调用 `/app/apps/api/node_modules/.bin/prisma migrate deploy`。
- 不修改活动生产库、不执行生产恢复、不开放 3000/3306；首次真实部署仅在备份和单独授权后执行。
- 所有新增 `*.sh`、`*.mjs`、`*.mts` 保持 LF；测试中的临时文件和数据库夹具必须在 `finally` 中按本轮唯一标识清理。
- 每个代码任务独立提交；外部发布动作不与代码修改混在同一提交。

## File Map and Responsibilities

### Modify

- `Dockerfile` — 运行阶段移除 Corepack/pnpm，证明 Prisma CLI 可执行，保留非 root、只读根和 `tini`。
- `scripts/docker/entrypoint.sh` — 预检后直接执行 Prisma CLI并保持信号/退出码语义。
- `docker-compose.test.yml` — 测试容器使用同一 Prisma 可执行文件，并允许 CI 注入已构建候选镜像。
- `apps/api/test/entrypoint-signal.spec.ts` — 迁移成功/失败及 HUP/INT/TERM 的行为回归。
- `apps/api/test/deployment-artifacts.spec.ts` — Dockerfile、registry Compose、模板、CI workflow 和文档静态契约。
- `.gitignore` — 明确跟踪不含秘密的极空间环境模板。
- `.dockerignore` — 继续拒绝真实环境文件和测试产物进入构建上下文。
- `docs/deployment/synology.md` — 指向新的 registry 部署方式，保留源码构建说明作为维护入口。

### Create

- `docker-compose.registry.yml` — 极空间从 Docker Hub 拉取固定版本的生产 Compose。
- `.env.extremespace.example` — 不含真实秘密的极空间环境模板。
- `docs/deployment/extremespace.md` — 从空目录到固定版本部署、升级、回滚和备份的操作卡。
- `scripts/database/ci-test-environment.mjs` — 纯函数验证 GitHub Actions 隔离测试数据库目标。
- `scripts/database/run-with-ci-test-env.mjs` — 使用当前进程环境启动受保护 CI 命令，不读取 `.env.local`。
- `apps/api/test/ci-test-environment.spec.ts` — CI 数据库门禁的纯测试。
- `scripts/release/docker-publish-contract.mjs` — 版本、远端固定标签、manifest 平台和镜像身份的 fail-closed 校验器。
- `apps/api/test/docker-publish-contract.spec.ts` — 发布契约纯测试。
- `scripts/ci/verify-candidate-image.sh` — 候选镜像的迁移、健康、非 root、只读根和卷持久性烟测。
- `apps/api/test/docker-publish-workflow.spec.ts` — GitHub workflow、候选烟测和标签策略的静态回归。
- `.github/workflows/verify.yml` — PR/普通提交验证，可被发布 workflow 复用。
- `.github/workflows/publish-docker.yml` — 语义版本 tag 的多架构发布与验证。
- `.github/workflows/promote-latest.yml` — 固定版本已发布但 `latest` 提升失败时的手动恢复入口。

---

## Task 1: Remove the Runtime Corepack Dependency Without Removing Migrations

**Files:**

- Modify: `apps/api/test/deployment-artifacts.spec.ts`
- Modify: `apps/api/test/entrypoint-signal.spec.ts`
- Modify: `Dockerfile`
- Modify: `scripts/docker/entrypoint.sh`
- Modify: `docker-compose.test.yml`

- [ ] **Step 1: Add failing artifact assertions**

Extend the Dockerfile/entrypoint test with runtime-stage-only assertions:

```ts
const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:24-bookworm-slim AS runtime'));
expect(runtime).not.toMatch(/corepack|PNPM_HOME|pnpm\s/);
expect(runtime).toContain('test -x /app/apps/api/node_modules/.bin/prisma');
expect(runtime).not.toContain('COPY scripts ./scripts');
expect(runtime).not.toMatch(/\.test\.ts|run-with-test-env|seed-release-drill|assert-restored/);
expect(entrypoint).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy');
expect(entrypoint).not.toMatch(/\bpnpm\b|\bcorepack\b/);
expect(compose.services.app.command).toContain(
  '/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js'
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts test/deployment-artifacts.spec.ts test/entrypoint-signal.spec.ts
```

Expected: failures show runtime Corepack/pnpm usage and the old `pnpm --dir apps/api exec prisma` command.

- [ ] **Step 3: Make the entrypoint behavior tests exercise a direct Prisma executable**

Stage a temporary copy of the entrypoint for behavioral tests, replacing only the fixed production path with the test fake path:

```ts
const productionEntrypoint = await readFile(entrypoint, 'utf8');
const stagedEntrypoint = join(root, 'entrypoint.sh');
const fakePrisma = join(root, 'app', 'apps', 'api', 'node_modules', '.bin', 'prisma');
await mkdir(join(fakePrisma, '..'), { recursive: true });
await executable(fakePrisma, prismaBehavior);
await executable(
  stagedEntrypoint,
  productionEntrypoint.replace('/app/apps/api/node_modules/.bin/prisma', shellPath(fakePrisma))
);
```

Keep the existing one-off-command, migration failure, API-not-started, and TERM assertions; add HUP and INT parameter cases if they are not already covered by equivalent entrypoint tests.

- [ ] **Step 4: Implement the minimal runtime change**

In `scripts/docker/entrypoint.sh`, replace the migration child command with:

```bash
/app/apps/api/node_modules/.bin/prisma migrate deploy &
```

In the runtime Docker stage:

- remove runtime `PNPM_HOME`, runtime `PATH=/pnpm`, `corepack enable`, and `corepack prepare`;
- retain Corepack only in build/dependency stages;
- replace the broad runtime `COPY scripts ./scripts` with explicit copies of only `entrypoint.sh`, `healthcheck.mjs`, `production-preflight.mjs`, `create-database.mjs`, `production-backup-target.mjs`, `production-migration-evidence.mjs`, `backup.sh`, `restore.sh`, and `restore-input-guard.mjs`;
- after production dependencies are copied, assert:

```dockerfile
RUN test -x /app/apps/api/node_modules/.bin/prisma
```

In `docker-compose.test.yml`, use:

```yaml
image: ${POKER_TEST_IMAGE:-poker-scorekeeper:test-local}
command:
  - /usr/bin/tini
  - -g
  - --
  - sh
  - -c
  - /app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js
```

- [ ] **Step 5: Verify GREEN and shell syntax**

Run the focused Vitest command, then:

```powershell
bash -n scripts/docker/entrypoint.sh
git diff --check
```

Expected: focused tests pass; no CRLF or shell parse error.

- [ ] **Step 6: Commit Task 1**

```powershell
git add Dockerfile scripts/docker/entrypoint.sh docker-compose.test.yml apps/api/test/entrypoint-signal.spec.ts apps/api/test/deployment-artifacts.spec.ts
git commit -m "fix: run prisma migrations without runtime pnpm"
```

## Task 2: Add the Fixed-Version Extreme Space Deployment Bundle

**Files:**

- Modify: `apps/api/test/deployment-artifacts.spec.ts`
- Modify: `.gitignore`
- Create: `docker-compose.registry.yml`
- Create: `.env.extremespace.example`

- [ ] **Step 1: Add failing registry Compose and template tests**

Parse `docker-compose.registry.yml` and assert:

```ts
expect(Object.keys(compose.services)).toEqual(['app']);
expect(compose.services.app.build).toBeUndefined();
expect(compose.services.app.image).toBe(
  'docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION:?POKER_IMAGE_VERSION is required}'
);
expect(compose.services.app.ports).toEqual(['127.0.0.1:3000:3000']);
expect(compose.services.app.env_file).toEqual(['.env.production']);
expect(compose.services.app.volumes).toEqual(expect.arrayContaining([
  './data/avatars:/data/avatars',
  './data/backups:/data/backups',
  './data/restore:/data/restore'
]));
expect(compose.services.app.read_only).toBe(true);
expect(compose.services.app.cap_drop).toContain('ALL');
```

Read `.env.extremespace.example` and assert `POKER_IMAGE_VERSION=1.0.0`, the exact production host/schema placeholders, and absence of any high-confidence credential.

- [ ] **Step 2: Run the artifact test and confirm RED**

Expected: both new files are missing.

- [ ] **Step 3: Create `docker-compose.registry.yml`**

Copy only the runtime controls from `docker-compose.yml`; replace `build` and local image with the required public image. Do not add a MySQL service or publish port 3306. Keep:

```yaml
restart: unless-stopped
read_only: true
tmpfs:
  - /tmp:size=64m,mode=1777
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
healthcheck:
  test: ["CMD", "node", "scripts/docker/healthcheck.mjs"]
```

- [ ] **Step 4: Create the safe environment template**

Include `POKER_IMAGE_VERSION=1.0.0` and all required runtime/backup fields. Use only explicit placeholders such as:

```dotenv
PUBLIC_ORIGIN=https://poker.example.com
DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper
SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES
CSRF_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES
BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_UNIQUE_STRONG_PASSWORD
MYSQL_PASSWORD=CHANGE_ME
```

Add `!.env.extremespace.example` to `.gitignore`; keep `.env.production` ignored.

- [ ] **Step 5: Verify GREEN and Compose interpolation behavior**

Run the focused artifact test. Have the test create an ignored file at `test-results/extremespace-compose.env` containing the checked-in example values, then run:

```powershell
docker compose --env-file test-results/extremespace-compose.env -f docker-compose.registry.yml config --quiet
```

If Docker Compose is unavailable, record this as an environment blocker and do not weaken the static test. The eventual CI publish gate must execute this command.

- [ ] **Step 6: Commit Task 2**

```powershell
git add .gitignore .env.extremespace.example docker-compose.registry.yml apps/api/test/deployment-artifacts.spec.ts
git commit -m "feat: add registry deployment bundle"
```

## Task 3: Add an Isolated GitHub Actions Test-Database Guard

**Files:**

- Create: `scripts/database/ci-test-environment.mjs`
- Create: `scripts/database/run-with-ci-test-env.mjs`
- Create: `apps/api/test/ci-test-environment.spec.ts`

- [ ] **Step 1: Write pure failing tests for the CI target**

Define this interface:

```js
export function validateCiTestEnvironment(environment) {
  // returns a validated URL; throws CI_TEST_DATABASE_TARGET_REFUSED otherwise
}
```

Test acceptance only when all are true:

- `CI=true`;
- `GITHUB_ACTIONS=true`;
- protocol is `mysql:`;
- host is `127.0.0.1`;
- port is `3306`;
- schema is exactly `poker_scorekeeper_ci_test`.

Test rejection for `tianyi.wiki`, `192.168.10.248`, any production schema, missing CI markers, encoded host tricks, query/fragment ambiguity, and a poisoned parent `DATABASE_URL`.

- [ ] **Step 2: Run and confirm RED**

Expected: import fails because `ci-test-environment.mjs` does not exist.

- [ ] **Step 3: Implement the pure validator and guarded runner**

`run-with-ci-test-env.mjs` must:

1. validate `process.env` through the pure function;
2. on `--check-only`, connect and execute only `SELECT 1`;
3. otherwise spawn the supplied command with `shell: false` and the already validated environment;
4. propagate signal/exit status;
5. never read `.env.local` and never print the URL.

- [ ] **Step 4: Verify GREEN**

Run the focused unit test and static scan:

```powershell
rg -n "\.env\.local|DATABASE_URL.*stdout|console\.log" scripts/database/run-with-ci-test-env.mjs scripts/database/ci-test-environment.mjs
```

Expected: no `.env.local` load and no URL output.

- [ ] **Step 5: Commit Task 3**

```powershell
git add scripts/database/ci-test-environment.mjs scripts/database/run-with-ci-test-env.mjs apps/api/test/ci-test-environment.spec.ts
git commit -m "test: isolate github actions database access"
```

## Task 4: Encode the Immutable Docker Publication Contract

**Files:**

- Create: `scripts/release/docker-publish-contract.mjs`
- Create: `apps/api/test/docker-publish-contract.spec.ts`

- [ ] **Step 1: Write failing release-contract tests**

Expose these pure functions plus a small CLI:

```js
export function deriveReleaseMetadata(refName, fullCommit) {}
export async function assertDockerHubTagAbsent(repository, version, fetchImpl) {}
export function assertManifestPlatforms(rawManifest, expectedPlatforms) {}
export function assertImageIdentity(labels, expectedCommit) {}
```

Required cases:

- `v1.0.0` produces version `1.0.0`, a `sha-` tag followed by the full 40-character lowercase commit, and deployment ID equal to that commit;
- prerelease, build metadata, missing `v`, uppercase SHA, short SHA, branch names, and `latest` are rejected;
- Docker Hub tag API status 404 means absent; 200 means `FIXED_TAG_ALREADY_EXISTS`; every other response/network error means `REMOTE_TAG_STATUS_UNKNOWN`;
- manifest must contain exactly one `linux/amd64` and one `linux/arm64`, without duplicates or extra executable platforms;
- both architecture configs must have `org.opencontainers.image.revision` equal to the full commit.

- [ ] **Step 2: Run and confirm RED**

Expected: module missing.

- [ ] **Step 3: Implement fail-closed validation**

Use strict patterns:

```js
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
```

The live tag check must query only:

```text
https://hub.docker.com/v2/repositories/tianyi920/poker-scorekeeper/tags/1.0.0
```

The CLI must print only non-secret release metadata or stable error codes.

- [ ] **Step 4: Verify GREEN and CLI failure behavior**

Run the focused tests, then invoke the CLI with invalid refs and verify exit code 1 and no stack/URL credential output.

- [ ] **Step 5: Commit Task 4**

```powershell
git add scripts/release/docker-publish-contract.mjs apps/api/test/docker-publish-contract.spec.ts
git commit -m "feat: enforce immutable docker release metadata"
```

## Task 5: Add the Candidate-Image Smoke Gate

**Files:**

- Create: `scripts/ci/verify-candidate-image.sh`
- Modify: `docker-compose.test.yml`
- Modify: `apps/api/test/docker-publish-workflow.spec.ts` (create in this task)

- [ ] **Step 1: Add failing static tests for smoke coverage**

Assert the script:

- requires `POKER_TEST_IMAGE` and a safe unique Compose project;
- runs `docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml up -d --no-build`;
- waits for `/api/health/live` and `/api/health/ready`;
- first runs the app once with test-only invalid DB credentials, requires a nonzero migration exit, and proves the API health port never becomes ready;
- checks container UID is nonzero and `ReadonlyRootfs` is true;
- writes unique markers to avatar and backup volumes, restarts the app, and verifies both markers persist;
- always runs `docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml down -v --remove-orphans` from `trap` cleanup;
- never references production/test remote hosts.

- [ ] **Step 2: Run and confirm RED**

Expected: smoke script is missing.

- [ ] **Step 3: Implement the minimal Bash smoke script**

Use argument arrays, an anchored project-name regex, bounded retry loops, test-only invalid credentials for the negative migration probe, and unique marker names. Do not use `eval`, broad `docker system prune`, or host-mounted secrets.

The test Compose must continue to override the production entrypoint and invoke the same direct Prisma executable; CI uses the already built local image through `POKER_TEST_IMAGE` and `--no-build`.

Also make the test app exercise the production security shape:

```yaml
read_only: true
tmpfs:
  - /tmp:size=64m,mode=1777
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

- [ ] **Step 4: Verify locally when Docker is available**

Build only AMD64 locally with a test deployment ID, then run the smoke script. Expected: empty DB migrates, both health endpoints pass, UID is nonzero, root is read-only, markers survive restart, and cleanup removes the project volumes.

If Docker is unavailable, retain RED/blocked container evidence and rely on the later GitHub hosted-runner gate before any publication.

- [ ] **Step 5: Commit Task 5**

```powershell
git add scripts/ci/verify-candidate-image.sh docker-compose.test.yml apps/api/test/docker-publish-workflow.spec.ts
git commit -m "test: verify candidate container persistence"
```

## Task 6: Add Reusable Verification and Multi-Architecture Publish Workflows

**Files:**

- Create: `.github/workflows/verify.yml`
- Create: `.github/workflows/publish-docker.yml`
- Create: `.github/workflows/promote-latest.yml`
- Modify: `apps/api/test/docker-publish-workflow.spec.ts`

- [ ] **Step 1: Extend workflow tests and confirm RED**

Parse all three YAML files and assert:

- `verify.yml` runs on pull requests, branch pushes, and `workflow_call`;
- permissions are `contents: read` and no broader write permission;
- the MySQL service creates only `poker_scorekeeper_ci_test` and exposes only the runner-local service port;
- all DB-backed commands go through `run-with-ci-test-env.mjs`;
- `publish-docker.yml` triggers only on `v*.*.*`, calls the strict metadata validator, checks the fixed tag before login/push, and requests only `contents: read`;
- build platforms are exactly `linux/amd64,linux/arm64`;
- login references only `secrets.DOCKERHUB_USERNAME` and `secrets.DOCKERHUB_TOKEN`;
- the job compares `secrets.DOCKERHUB_USERNAME` to `tianyi920` without echoing either Secret and fails before login on mismatch;
- version and the `sha-` plus full-commit tag publish before `latest` promotion;
- `latest` is created from the verified digest, never rebuilt;
- recovery workflow accepts a fixed version, revalidates its digest/platform/identity, then promotes only that digest.

- [ ] **Step 2: Implement `verify.yml`**

Use Node 24 and pnpm 10.15.1. Configure an isolated MySQL 8.4 service with test-only credentials. Set:

```yaml
CI: "true"
GITHUB_ACTIONS: "true"
DATABASE_URL: mysql://poker_ci:poker_ci@127.0.0.1:3306/poker_scorekeeper_ci_test
BASH_PATH: /usr/bin/bash
PUBLIC_ORIGIN: http://127.0.0.1:3000
SESSION_SECRET: ci_only_session_secret_0123456789abcdef0123456789abcdef
CSRF_SECRET: ci_only_csrf_secret_0123456789abcdef0123456789abcdef
BOOTSTRAP_ADMIN_USERNAME: ciadmin
BOOTSTRAP_ADMIN_NICKNAME: CI Administrator
BOOTSTRAP_ADMIN_PASSWORD: CI-only-password-12345
```

Run, in order:

1. frozen install;
2. guarded DB connectivity;
3. lint and typecheck;
4. full package tests;
5. API integration tests;
6. Playwright Chromium/WebKit installation and 23-test browser suite;
7. build;
8. diff/secret checks.

Do not inject production DB, bootstrap password, Session secret, or CSRF secret from repository Secrets; use explicit test-only values in the job environment.

- [ ] **Step 3: Implement the publish workflow**

Sequence the jobs as:

```text
verify -> metadata/fixed-tag check -> amd64 candidate build+smoke -> multiarch push
       -> remote manifest+per-platform identity check -> digest-based latest promotion
```

Build arguments must include:

```text
DEPLOYMENT_ID=${{ github.sha }}
```

Use reviewed immutable commit-SHA pins for every third-party Action. The implementation step must resolve those SHAs from the official action repositories, record the matching release tag in a comment, and never use a moving branch.

- [ ] **Step 4: Implement digest verification and promotion**

After pushing the fixed and commit tags:

1. save the raw remote OCI index to a file;
2. validate the two required platforms with `docker-publish-contract.mjs`;
3. inspect both platform configs and validate the revision label equals `GITHUB_SHA`;
4. record the fixed tag digest;
5. promote with `docker buildx imagetools create --tag docker.io/tianyi920/poker-scorekeeper:latest "docker.io/tianyi920/poker-scorekeeper@$VERIFIED_DIGEST"`;
6. re-read `latest` and assert the digest is identical.

- [ ] **Step 5: Implement the manual recovery workflow**

`workflow_dispatch` input accepts only `1.0.0`-style fixed versions. It must not build or overwrite the fixed version. It reads the full commit from both platform revision labels, requires those labels to agree, verifies that `sha-` plus that commit resolves to the same digest as the fixed version, then only repoints `latest` to that verified digest.

- [ ] **Step 6: Run static and syntax verification**

Run:

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts test/docker-publish-workflow.spec.ts test/docker-publish-contract.spec.ts test/ci-test-environment.spec.ts
git diff --check
```

Also parse all workflow YAML. Expected: no unexpanded placeholder, no `continue-on-error`, no mutable fixed-tag push path, and no production hostname.

- [ ] **Step 7: Commit Task 6**

```powershell
git add .github/workflows scripts/release/docker-publish-contract.mjs scripts/database/ci-test-environment.mjs scripts/database/run-with-ci-test-env.mjs apps/api/test/docker-publish-workflow.spec.ts apps/api/test/docker-publish-contract.spec.ts apps/api/test/ci-test-environment.spec.ts
git commit -m "ci: publish verified multiarch docker images"
```

## Task 7: Write the Extreme Space Runbook and Upgrade Card

**Files:**

- Modify: `apps/api/test/deployment-artifacts.spec.ts`
- Create: `docs/deployment/extremespace.md`
- Modify: `docs/deployment/synology.md`

- [ ] **Step 1: Add failing documentation assertions**

Assert the new runbook names the exact files and image, contains no real secret, and includes all commands:

```text
docker-compose.registry.yml
.env.extremespace.example
docker.io/tianyi920/poker-scorekeeper:1.0.0
cp .env.extremespace.example .env.production
chmod 600 .env.production
docker compose --env-file .env.production -f docker-compose.registry.yml pull
docker compose --env-file .env.production -f docker-compose.registry.yml up -d
/api/health/live
/api/health/ready
/api/health/deployment
```

Also require fixed-version upgrade and rollback examples and prohibit `latest` in the production command examples.

- [ ] **Step 2: Run and confirm RED**

Expected: `docs/deployment/extremespace.md` is missing.

- [ ] **Step 3: Write the runbook for a source-free NAS**

The first section must answer the user's earlier questions directly:

- source repository: private `github.com/tianyi0920/poker-scorekeeper`;
- image repository: public `docker.io/tianyi920/poker-scorekeeper`;
- Compose template: repository root `docker-compose.registry.yml`;
- environment template: repository root `.env.extremespace.example`;
- NAS does not need the full source tree.

Use a user-selected NAS path instead of inventing a device-specific mount:

```sh
export POKER_DIR=/path/selected-in-extremespace/poker-scorekeeper
mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore
cd "$POKER_DIR"
```

Document HTTPS/WebSocket reverse proxy, backup before upgrade, fixed-version edit, pull/up, health checks, log inspection, and rollback to the previous fixed version. State explicitly that DB migrations are forward-only and image rollback does not roll back schema.

- [ ] **Step 4: Link the new runbook from Synology documentation**

Keep the existing source-build/verification material, but identify registry deployment as the recommended Extreme Space path.

- [ ] **Step 5: Verify docs and secret scan**

Run the focused artifact test plus a high-confidence credential scan over the two templates, Compose, workflows, and docs. Expected: only `CHANGE_ME`/example values.

- [ ] **Step 6: Commit Task 7**

```powershell
git add docs/deployment/extremespace.md docs/deployment/synology.md apps/api/test/deployment-artifacts.spec.ts
git commit -m "docs: add extreme space registry deployment guide"
```

## Task 8: Run the Complete Local Verification Matrix

**Files:**

- Modify only files proven necessary by failures; do not relax tests to hide product defects.
- Update: `docs/superpowers/specs/2026-08-20-docker-hub-extremespace-deployment-design.md` only if implementation decisions materially changed and the user approves the design delta.

- [ ] **Step 1: Verify repository state and ignored secrets**

```powershell
git status --short
git check-ignore .env.local .env.production
git ls-files .env.local .env.production
```

Expected: secret files ignored and untracked.

- [ ] **Step 2: Run pure/static gates**

Run frozen install, lint, typecheck, package tests, build, Prisma generate/validate, Bash/Node syntax, YAML parse, LF checks, `git diff --check`, and high-confidence secret scan.

- [ ] **Step 3: Run DB-backed gates only against an authorized test target**

Locally, keep using the existing exact guarded test target. Run API E2E and all integration suites. Before and after, assert the database is the authorized `poker_scorekeeper_test`, inspect open transactions/locks, and clean only fixtures owned by the current run.

- [ ] **Step 4: Run browser gates**

Run the complete Chromium/WebKit suite, including 1/8/12-player mobile matrices. Verify no test users/games, listeners, or Playwright processes remain.

- [ ] **Step 5: Run container gates if Docker is available**

Run the direct-Prisma candidate smoke and the existing full release drill. If local Docker remains unavailable, do not claim container completion; require the first GitHub Actions run to supply this evidence before publishing.

- [ ] **Step 6: Commit only evidence-driven fixes**

Each discovered defect gets RED → minimal GREEN → focused regression before a separate commit. Do not amend earlier task commits.

## Task 9: External Repository and Secret Provisioning — Authorization Checkpoint

**No repository files should change in this task.**

- [ ] **Step 1: Stop and request explicit authorization to create the private GitHub repository**

Target: `github.com/tianyi0920/poker-scorekeeper`, private, no auto-generated README/license/gitignore because the local history already exists.

- [ ] **Step 2: After authorization, create the GitHub repository and verify privacy**

Add `origin` only after confirming the returned owner/name/privacy. Do not push yet.

- [ ] **Step 3: Stop and request explicit authorization to create the public Docker Hub repository**

Target: `docker.io/tianyi920/poker-scorekeeper`, public. Verify namespace and repository spelling before creation.

- [ ] **Step 4: Stop for user-controlled Docker Hub token creation**

Create a dedicated read/write token for this repository. The token must never be pasted into chat or a command argument. Prefer direct entry into GitHub's Secret form.

- [ ] **Step 5: Save GitHub Actions Secrets**

Names:

```text
DOCKERHUB_USERNAME
DOCKERHUB_TOKEN
```

Verify only the Secret names and update timestamps, never the value.

## Task 10: First Push, CI Verification, and `v1.0.0` Publication — Authorization Checkpoint

**No production database action is authorized by this task.**

- [ ] **Step 1: Stop and request authorization for the first source push**

Before pushing, show:

- branch and exact HEAD;
- commit list to be pushed;
- private target repository;
- tracked/commit secret scan result;
- clean worktree result.

- [ ] **Step 2: Push the implementation branch and open/merge through the user's chosen GitHub flow**

Do not bypass failed required checks. Record the merge commit that will become the release source.

- [ ] **Step 3: Verify the ordinary GitHub Actions workflow**

Require successful isolated DB tests, Playwright, build, candidate image smoke, and no production endpoint access. If any step is skipped or inconclusive, do not tag.

- [ ] **Step 4: Stop and request authorization to create and push `v1.0.0`**

Show the exact commit and confirm the remote fixed tag does not already exist.

- [ ] **Step 5: Push the annotated version tag**

```powershell
git tag -a v1.0.0 $(git rev-parse HEAD) -m "poker-scorekeeper 1.0.0"
git push origin v1.0.0
```

- [ ] **Step 6: Verify publication evidence**

Require all of the following before marking the release complete:

- Docker tags `1.0.0`, `sha-` plus the full release commit, and `latest` exist;
- fixed and `latest` resolve to the same multiarch digest;
- platforms are exactly `linux/amd64` and `linux/arm64`;
- both image configs carry the expected OCI revision;
- workflow logs contain no secret value;
- the candidate image smoke completed against isolated MySQL.

If fixed publication succeeds but `latest` promotion fails, run only the authorized recovery workflow; never rebuild or overwrite `1.0.0`.

## Task 11: Extreme Space First Deployment — Separate Production Authorization

**This task is not implied by publishing the image. It requires a fresh backup and explicit production authorization.**

- [ ] **Step 1: Prepare the NAS directory and copy only the two deployment files**

Copy `docker-compose.registry.yml` and `.env.extremespace.example`; create `.env.production` locally on the NAS with mode 600 and create the three data directories.

- [ ] **Step 2: Back up the existing MariaDB and avatar data**

Verify the backup four-piece set and checksums before pulling the new image.

- [ ] **Step 3: Review the exact production diff with the user**

Show fixed image version, image digest, database target, port binding, volumes, public origin, and rollback version. Do not display passwords.

- [ ] **Step 4: Obtain explicit authorization and deploy `1.0.0`**

Pull the fixed tag, start the container, and observe the automatic preflight/migration/start sequence. If migration fails, stop; do not bypass the entrypoint.

- [ ] **Step 5: Perform production acceptance**

Verify live/ready/deployment endpoints, admin login, existing users/games/history/avatar reads, WebSocket, HTTPS-only proxy exposure, first post-deploy backup, and a documented fixed-version rollback command.

## Final Completion Checklist

- [ ] Runtime image contains no runtime Corepack/pnpm dependency.
- [ ] Automatic Prisma migration remains fail-closed and signal-safe.
- [ ] Registry Compose and environment template are independently usable and secret-free.
- [ ] CI uses only isolated MySQL and never receives production credentials.
- [ ] Version and commit tags are immutable; `latest` is digest-promoted after verification.
- [ ] GitHub repository is private and Docker Hub repository is public.
- [ ] AMD64 and ARM64 manifests and OCI revisions are verified remotely.
- [ ] Extreme Space documentation clearly identifies repository, template, directories, fixed-version upgrade, backup, and rollback.
- [ ] Every external write and production action has its own recorded user approval.
