# Direct HTTP IPv6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production poker scorekeeper serve direct dual-stack HTTP on container port 80 with no reverse proxy, TLS, or ACME service.

**Architecture:** Nest listens on one IPv6 unspecified socket at `::`:80, using Node's default dual-stack behavior. Production Compose publishes TCP 80 and enables unprivileged low-port binding through a namespaced sysctl while retaining the non-root runtime and dropped capabilities; tests keep explicit port 3000 overrides.

**Tech Stack:** Node.js 24, NestJS 11, Vitest, Docker Compose, Extreme Space NAS

**Spec:** `docs/superpowers/specs/2026-08-22-direct-http-ipv6-design.md`

## Global Constraints

- Production default port is exactly 80.
- Production listen host is exactly `::`; the application does not enable IPv6-only mode.
- No TLS, ACME service, certificate volume, AccessKey, or reverse proxy is added.
- Runtime remains non-root with `no-new-privileges` and all Linux capabilities dropped.
- Direct-access production never trusts forwarded client-address headers and an HTTP public origin never emits HSTS.
- Test harnesses may continue to override `PORT=3000`.
- No real credential is written to the repository.

---

### Task 1: Dual-stack runtime and dynamic health check

**Files:**

- Modify: `apps/api/test/health.e2e-spec.ts`
- Create: `apps/api/src/auth/session.service.test.ts`
- Create: `apps/api/test/docker-healthcheck.spec.ts`
- Create: `scripts/docker/healthcheck-url.mjs`
- Create: `scripts/docker/healthcheck-url.d.mts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/auth/session.service.ts`
- Create: `apps/api/src/common/security/application-security.test.ts`
- Modify: `apps/api/src/common/security/application-security.ts`
- Modify: `apps/api/test/security.e2e-spec.ts`
- Modify: `scripts/docker/healthcheck.mjs`

**Interfaces:**

- Produces: `getListenOptions(): { port: string | number; host: '::' }`
- Produces: `getHealthcheckUrl(environment?: NodeJS.ProcessEnv): string`

- [x] **Step 1: Write failing tests**

Change the existing default-port assertion to 80 and add:

```ts
expect(getListenOptions()).toEqual({ port: 80, host: '::' });
```

Add health-check URL cases for an absent `PORT` (`http://127.0.0.1:80/api/health/ready`) and `PORT=3000`.

Add cookie cases proving an HTTP public origin disables only `Secure`, an HTTPS public origin keeps it, and a malformed production origin fails closed with `Secure=true`.

Add security cases proving direct production ignores forwarded client addresses, HTTP disables HSTS, and production HTTPS retains HSTS.

- [x] **Step 2: Run tests and confirm RED**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/health.e2e-spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.config.ts ../../scripts/docker/healthcheck.test.ts
```

Expected: default remains 3000, `getListenOptions` is missing, and healthcheck URL is hard-coded.

- [x] **Step 3: Implement the minimal runtime change**

Use:

```ts
export function getPort(): string | number {
  return process.env.PORT || 80;
}

export function getListenOptions() {
  return { port: getPort(), host: '::' as const };
}
```

Pass `getListenOptions()` to `app.listen`. Refactor the health-check script so its URL derives from `PORT || 80` while preserving the four-second timeout and exit behavior.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run both commands from Step 2. Expected: all selected tests pass.

### Task 2: Production container and Compose defaults

**Files:**

- Modify: `apps/api/test/deployment-artifacts.spec.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.registry.yml`
- Modify: `.env.example`
- Modify: `.env.extremespace.example`

**Interfaces:**

- Consumes: application listener on container TCP 80.
- Produces: runtime image exposing 80 and production Compose publishing `80:80`.

- [x] **Step 1: Write failing deployment assertions**

Require both production Compose files to set `PORT: "80"`, publish `80:80`, retain `cap_drop: [ALL]`, and include:

```yaml
sysctls:
  net.ipv4.ip_unprivileged_port_start: "0"
```

Require Dockerfile defaults `PORT=80` and `EXPOSE 80`; reject production `3000:3000` mappings.

- [x] **Step 2: Run the artifact test and confirm RED**

```powershell
pnpm --filter @poker/api exec vitest run --config vitest.config.ts test/deployment-artifacts.spec.ts
```

Expected: existing port-3000 assertions fail.

- [x] **Step 3: Implement production artifact changes**

Update only production defaults. Keep `docker-compose.test.yml`, Playwright, and E2E helpers on explicit port 3000.

- [x] **Step 4: Render both Compose configurations**

```powershell
docker compose --env-file .env.example -f docker-compose.yml config --quiet
docker compose --env-file .env.extremespace.example -f docker-compose.registry.yml config --quiet
```

Expected: both render successfully without an ACME or TLS service.

- [x] **Step 5: Run the artifact test and confirm GREEN**

Run the command from Step 2. Expected: all deployment artifact cases pass.

### Task 3: Extreme Space direct-IPv6 operations guide

**Files:**

- Modify: `apps/api/test/deployment-artifacts.spec.ts`
- Modify: `docs/deployment/extremespace.md`
- Modify: `docs/deployment/production-checklist.md`

**Interfaces:**

- Consumes: container HTTP port 80 and dual-stack listener.
- Produces: exact DNS, firewall, deployment, health-check, and rollback instructions.

- [x] **Step 1: Add failing documentation assertions**

Require the guide to name `http://pk.tianyi.wiki`, direct container IPv6, AAAA equality, inbound IPv6 TCP 80, `/api/health/live`, `/api/health/ready`, and WebSocket acceptance. Reject instructions that require a reverse proxy or application certificate.

- [x] **Step 2: Run and confirm RED**

Run the deployment artifact test. Expected: the existing reverse-proxy guide violates the new contract.

- [x] **Step 3: Update the runbook and checklist**

Document that the container network must provide a globally routable IPv6, `pk.tianyi.wiki` AAAA must equal it, and HTTP is unencrypted. Replace production health probes with port 80 URLs.

- [x] **Step 4: Run and confirm GREEN**

Run the deployment artifact test. Expected: all documentation assertions pass.

### Task 4: Complete verification

**Files:**

- Modify only files proven necessary by failures.

- [x] **Step 1: Run lint, typecheck, focused tests, and build**

```powershell
pnpm lint
pnpm typecheck
pnpm --filter @poker/api exec vitest run --config vitest.config.ts test/deployment-artifacts.spec.ts
pnpm --filter @poker/api exec vitest run --config vitest.e2e.config.ts test/health.e2e-spec.ts
pnpm build
```

- [x] **Step 2: Run secret and diff checks**

```powershell
node scripts/security/scan-tracked-secrets.mjs
git diff --check
git status --short
```

- [x] **Step 3: Record environment-limited gates honestly**

If Docker, Bash, an authorized test database, or a live Extreme Space shell is unavailable, report those production gates as pending rather than claiming completion.

- [ ] **Step 4: Production acceptance after publishing**

Verify the live AAAA equals the container global IPv6, `TCP/80` succeeds over IPv6, the three health endpoints return success, login works, and Socket.IO updates work from a non-LAN client.

Local verification note: lint, typecheck, production build, 36 focused unit/artifact tests, 27 security E2E tests, both Compose renders, secret scan, and diff check pass. The MySQL-backed health E2E cannot bootstrap without an authorized test database, Docker runtime validation cannot run while the local Docker daemon is stopped, and live production acceptance remains pending until image publication and NAS deployment.
