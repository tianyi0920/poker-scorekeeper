import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function readRepositoryFile(path: string) {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      needs?: string | string[];
      uses?: string;
      permissions?: Record<string, string>;
      env?: Record<string, string>;
      services?: Record<string, Record<string, unknown>>;
      steps?: Array<Record<string, unknown>>;
    }
  >;
};

async function readWorkflow(name: string) {
  const source = await readRepositoryFile(`.github/workflows/${name}`);
  return { source, workflow: parse(source) as Workflow };
}

function runScripts(workflow: Workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

function actionReferences(workflow: Workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => [job.uses, ...(job.steps ?? []).map((step) => step.uses)])
    .filter((uses): uses is string => typeof uses === "string");
}

describe("GitHub Actions Docker publication workflows", () => {
  it("makes verification reusable for pull requests and branch pushes with only read permission", async () => {
    // Break caught: an ordinary verification event can publish, receive write permission, or omit a required CI entry point.
    const { source, workflow } = await readWorkflow("verify.yml");

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_call",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(
      /(?:packages|id-token|actions|attestations):\s*write/,
    );
    expect(source).not.toMatch(
      /docker\/(?:login|build-push)-action|imagetools create|push:\s*true/,
    );
  });

  it("isolates MySQL and gives every database-backed command the guarded public CI environment", async () => {
    // Break caught: CI can target a remote or production database, or bypass the database guard for a test command.
    const { workflow } = await readWorkflow("verify.yml");
    const verify = workflow.jobs?.verify;
    const mysql = verify?.services?.mysql as {
      image?: string;
      env?: Record<string, string>;
      ports?: string[];
    };

    expect(Object.keys(verify?.services ?? {})).toEqual(["mysql"]);
    expect(mysql.image).toBe("mysql:8.4");
    expect(mysql.env).toMatchObject({
      MYSQL_DATABASE: "poker_scorekeeper_ci_test",
      MYSQL_USER: "poker_ci",
      MYSQL_PASSWORD: "poker_ci",
    });
    expect(Object.values(mysql.env ?? {})).not.toContain("poker_scorekeeper");
    expect(mysql.ports).toEqual(["3306:3306"]);
    expect(verify?.env).toEqual(
      expect.objectContaining({
        CI: "true",
        GITHUB_ACTIONS: "true",
        DATABASE_URL:
          "mysql://poker_ci:poker_ci@127.0.0.1:3306/poker_scorekeeper_ci_test",
        BASH_PATH: "/usr/bin/bash",
        PUBLIC_ORIGIN: "http://127.0.0.1:3000",
        SESSION_SECRET:
          "ci_only_session_secret_0123456789abcdef0123456789abcdef",
        CSRF_SECRET: "ci_only_csrf_secret_0123456789abcdef0123456789abcdef",
        BOOTSTRAP_ADMIN_USERNAME: "ciadmin",
        BOOTSTRAP_ADMIN_NICKNAME: "CI Administrator",
        BOOTSTRAP_ADMIN_PASSWORD: "CI-only-password-12345",
      }),
    );

    const scripts = runScripts(workflow);
    expect(scripts).toContain(
      "node scripts/database/run-with-ci-test-env.mjs --check-only",
    );
    expect(scripts).toMatch(
      /run-with-ci-test-env\.mjs pnpm --filter @poker\/api prisma migrate deploy/,
    );
    expect(scripts).toMatch(/run-with-ci-test-env\.mjs pnpm test/);
    expect(scripts).toMatch(
      /run-with-ci-test-env\.mjs pnpm --filter @poker\/api test:integration/,
    );
    expect(scripts).toMatch(
      /run-with-ci-test-env\.mjs pnpm exec playwright test/,
    );
    expect(scripts).not.toMatch(
      /(?:^|\n)\s*(?:pnpm test|pnpm --filter @poker\/api test:integration|pnpm exec playwright test)/,
    );
  });

  it("runs the complete verification sequence and validates registry Compose with disposable example files", async () => {
    // Break caught: release verification skips a required suite or validates Compose with an undisclosed environment file.
    const { source, workflow } = await readWorkflow("verify.yml");
    const scripts = runScripts(workflow);
    const ordered = [
      "pnpm install --frozen-lockfile",
      "run-with-ci-test-env.mjs --check-only",
      "run-with-ci-test-env.mjs pnpm --filter @poker/api prisma migrate deploy",
      "pnpm lint",
      "pnpm typecheck",
      "run-with-ci-test-env.mjs pnpm test",
      "run-with-ci-test-env.mjs pnpm --filter @poker/api test:integration",
      "pnpm exec playwright install --with-deps chromium webkit",
      "run-with-ci-test-env.mjs pnpm exec playwright test",
      "pnpm build",
      "docker compose --env-file test-results/extremespace-compose.env -f docker-compose.registry.yml config --quiet",
    ];
    let position = -1;
    for (const command of ordered) {
      const next = scripts.indexOf(command);
      expect(next, command).toBeGreaterThan(position);
      position = next;
    }
    expect(scripts).toContain(
      "cp .env.extremespace.example test-results/extremespace-compose.env",
    );
    expect(scripts).toContain("cp .env.extremespace.example .env.production");
    expect(scripts).toMatch(
      /cleanup\(\)[\s\S]*rm -f test-results\/extremespace-compose\.env \.env\.production/,
    );
    expect(scripts).toContain("trap cleanup EXIT");
    expect(scripts).toContain("git diff --check");
    expect(source).not.toMatch(/secrets\./);
  });

  it("publishes only stable version tags after reusable verification and a fail-closed preflight", async () => {
    // Break caught: a branch, prerelease, or already-existing fixed tag reaches Docker Hub authentication or publication.
    const { source, workflow } = await readWorkflow("publish-docker.yml");
    const push = workflow.on?.push as { tags?: string[]; branches?: string[] };

    expect(Object.keys(workflow.on ?? {})).toEqual(["push"]);
    expect(push.tags).toEqual(["v*.*.*"]);
    expect(push.branches).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.verify?.uses).toBe("./.github/workflows/verify.yml");
    expect(workflow.jobs?.metadata?.needs).toBe("verify");
    const scripts = runScripts(workflow);
    expect(scripts).toContain("docker-publish-contract.mjs metadata");
    expect(scripts).toContain(
      "docker-publish-contract.mjs tag-absent tianyi920/poker-scorekeeper",
    );
    expect(
      source.indexOf("docker-publish-contract.mjs tag-absent"),
    ).toBeLessThan(source.indexOf("docker/login-action@"));
    expect(source).not.toMatch(/continue-on-error/);
  });

  it("smokes one unique local amd64 candidate before pushing exactly two identified platforms", async () => {
    // Break caught: publication skips local runtime proof, smokes a pullable tag, or pushes an incomplete platform set.
    const { source, workflow } = await readWorkflow("publish-docker.yml");
    const candidateScripts = (workflow.jobs?.candidate?.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === "string")
      .join("\n");
    const pushJob = workflow.jobs?.publish;
    const buildPush = (pushJob?.steps ?? []).find(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("docker/build-push-action@"),
    );

    expect(workflow.jobs?.candidate?.needs).toBe("metadata");
    expect(candidateScripts).toContain("--platform linux/amd64");
    expect(candidateScripts).toContain(
      '--build-arg "DEPLOYMENT_ID=$EXPECTED_COMMIT"',
    );
    expect(candidateScripts).toContain(
      "bash scripts/ci/verify-candidate-image.sh",
    );
    expect(candidateScripts).toMatch(
      /POKER_TEST_IMAGE="poker-scorekeeper:candidate-\$\{EXPECTED_COMMIT\}-\$\{candidate_suffix\}"/,
    );
    expect(candidateScripts).toMatch(
      /COMPOSE_PROJECT_NAME="poker-candidate-\$\{project_suffix\}"/,
    );
    expect(candidateScripts).not.toMatch(/docker pull/);
    expect(pushJob?.needs).toEqual(["metadata", "candidate"]);
    expect(buildPush?.with).toEqual(
      expect.objectContaining({
        platforms: "linux/amd64,linux/arm64",
        push: true,
        "build-args": "DEPLOYMENT_ID=${{ github.sha }}",
      }),
    );
    expect(
      String(
        buildPush?.with && (buildPush.with as Record<string, unknown>).tags,
      ),
    ).toContain(":${{ needs.metadata.outputs.version }}");
    expect(
      String(
        buildPush?.with && (buildPush.with as Record<string, unknown>).tags,
      ),
    ).toContain(":sha-${{ github.sha }}");
    expect(
      String(
        buildPush?.with && (buildPush.with as Record<string, unknown>).tags,
      ),
    ).not.toContain(":latest");
    expect(source).toContain("secrets.DOCKERHUB_USERNAME");
    expect(source).toContain("secrets.DOCKERHUB_TOKEN");
    expect(source).not.toMatch(/secrets\.(?!DOCKERHUB_(?:USERNAME|TOKEN))/);
  });

  it("checks the Docker Hub account without logging it and verifies remote identity before digest-only latest promotion", async () => {
    // Break caught: an unexpected account can push, or latest can be rebuilt before platform provenance is verified.
    const { source, workflow } = await readWorkflow("publish-docker.yml");
    const scripts = runScripts(workflow);
    const usernameChecks =
      scripts.match(
        /\[\[\s+"\$DOCKERHUB_USERNAME"\s+==\s+'tianyi920'\s+\]\]/g,
      ) ?? [];

    expect(usernameChecks.length).toBeGreaterThanOrEqual(2);
    expect(scripts).not.toMatch(
      /echo[^\n]*DOCKERHUB_USERNAME|printf[^\n]*DOCKERHUB_USERNAME/,
    );
    expect(workflow.jobs?.remote_verify?.needs).toBe("publish");
    expect(scripts).toContain(
      'imagetools inspect --raw "$FIXED_IMAGE" > raw-index.json',
    );
    expect(scripts).toContain(
      "docker-publish-contract.mjs manifest raw-index.json",
    );
    expect(scripts).toContain(
      'docker-publish-contract.mjs identity platform-identities.json "$GITHUB_SHA"',
    );
    expect(scripts).toMatch(
      /sha-\$\{GITHUB_SHA\}[\s\S]*COMMIT_DIGEST[\s\S]*VERIFIED_DIGEST/,
    );
    expect(workflow.jobs?.promote_latest?.needs).toBe("remote_verify");
    expect(scripts).toContain(
      'imagetools create --tag docker.io/tianyi920/poker-scorekeeper:latest "docker.io/tianyi920/poker-scorekeeper@$VERIFIED_DIGEST"',
    );
    expect(scripts).toMatch(/LATEST_DIGEST[\s\S]*VERIFIED_DIGEST/);
    const promotion = (workflow.jobs?.promote_latest?.steps ?? [])
      .map((step) => `${step.uses ?? ""}\n${step.run ?? ""}`)
      .join("\n");
    expect(promotion).not.toMatch(
      /build-push-action|docker (?:build|push)(?:\s|$)/,
    );
    expect(source.indexOf("docker-publish-contract.mjs identity")).toBeLessThan(
      source.lastIndexOf("imagetools create"),
    );
  });

  it("recovers latest only from a fixed version whose two labels and sha tag bind to one digest", async () => {
    // Break caught: manual recovery rebuilds or retags an unverified fixed image, or trusts one platform label.
    const { source, workflow } = await readWorkflow("promote-latest.yml");
    const dispatch = workflow.on?.workflow_dispatch as {
      inputs?: Record<string, Record<string, unknown>>;
    };
    const scripts = runScripts(workflow);

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(dispatch.inputs?.version).toEqual(
      expect.objectContaining({ required: true, type: "string" }),
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(scripts).toMatch(
      /\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/,
    );
    expect(scripts).toContain(
      "docker-publish-contract.mjs manifest raw-index.json",
    );
    expect(scripts).toContain("AMD64_REVISION");
    expect(scripts).toContain("ARM64_REVISION");
    expect(scripts).toMatch(/AMD64_REVISION[\s\S]*ARM64_REVISION/);
    expect(scripts).toContain(
      'docker-publish-contract.mjs identity platform-identities.json "$EXPECTED_COMMIT"',
    );
    expect(scripts).toContain("sha-${EXPECTED_COMMIT}");
    expect(scripts).toMatch(/SHA_DIGEST[\s\S]*FIXED_DIGEST/);
    expect(scripts).toContain(
      'imagetools create --tag docker.io/tianyi920/poker-scorekeeper:latest "docker.io/tianyi920/poker-scorekeeper@$VERIFIED_DIGEST"',
    );
    expect(scripts).toMatch(/LATEST_DIGEST[\s\S]*VERIFIED_DIGEST/);
    expect(source).not.toMatch(
      /build-push-action|docker (?:build|push)(?:\s|$)|continue-on-error/,
    );
    expect(source.match(/imagetools create/g)).toHaveLength(1);
  });

  it("pins every external Action to one immutable commit", async () => {
    // Break caught: a moving Action tag can change release behavior without repository review.
    for (const name of [
      "verify.yml",
      "publish-docker.yml",
      "promote-latest.yml",
    ]) {
      const { workflow } = await readWorkflow(name);
      for (const uses of actionReferences(workflow)) {
        if (uses.startsWith("./")) continue;
        expect(uses, `${name}: ${uses}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });
});

describe('candidate-image smoke contract', () => {
  it('fails closed around one isolated candidate image', async () => {
    // Break caught: a candidate smoke can pull or run an image that was not built for the expected commit.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('${POKER_TEST_IMAGE:?');
    expect(script).toContain('${EXPECTED_COMMIT:?');
    expect(script).toMatch(/\[\[\s+!\s+"\$EXPECTED_COMMIT"\s+=~\s+\^\[a-f0-9\]\{40\}\$\s+\]\]/);
    expect(script).toContain('candidate_image_pattern="^poker-scorekeeper:candidate-${EXPECTED_COMMIT}-[a-f0-9]{8}$"');
    expect(script).toMatch(/\[\[\s+!\s+"\$POKER_TEST_IMAGE"\s+=~\s+\$candidate_image_pattern\s+\]\]/);
    expect(script).toMatch(/docker image inspect --format '\{\{ index \.Config\.Labels "org\.opencontainers\.image\.revision" \}\}' "\$POKER_TEST_IMAGE"/);
    expect(script).toMatch(/\[\[\s+"\$image_revision"\s+==\s+"\$EXPECTED_COMMIT"\s+\]\]/);
    expect(script.indexOf('docker image inspect')).toBeLessThan(script.indexOf('compose=('));
    expect(script).toMatch(/\[\[\s+!\s+"\$COMPOSE_PROJECT_NAME"\s+=~\s+\^poker-candidate-\[a-f0-9\]\{12\}\$\s+\]\]/);
    expect(script).toContain('docker compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.test.yml');
    expect(script).toContain('up -d --pull never --no-build');
    const cleanup = script.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(cleanup).toContain('"${compose[@]}" down -v --remove-orphans');
    expect(script).toMatch(/trap cleanup EXIT/);
  });

  it('probes negative migration before healthy startup and keeps all endpoints local', async () => {
    // Break caught: a bad database credential starts the API, hangs forever, or is confused with another local listener.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    const negativeProbeStart = script.indexOf('timeout 30s "${compose[@]}" run');
    const negativeProbeEnd = script.indexOf('assert_app_absent', negativeProbeStart);
    const negativeProbe = script.slice(negativeProbeStart, negativeProbeEnd);
    expect(negativeProbe).toContain('-e "DATABASE_URL=$invalid_database_url"');
    expect(negativeProbe).toContain('app /app/apps/api/node_modules/.bin/prisma migrate deploy');
    expect(negativeProbe).not.toContain('node apps/api/dist/main.js');
    expect(negativeProbe).not.toContain('--service-ports');
    expect(negativeProbe).toContain('migration_status=$?');
    expect(negativeProbe).toMatch(/\(\( migration_status == 0 \)\)/);
    expect(negativeProbe).toMatch(/\(\( migration_status == 124 \)\)/);
    const mysqlStart = script.indexOf('"${compose[@]}" up -d --pull never --no-build mysql');
    expect(script.lastIndexOf('assert_port_unused', mysqlStart)).toBeLessThan(mysqlStart);
    expect(script).toMatch(/timeout 2s bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/3000'/);
    const absenceProbe = script.match(/assert_app_absent\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(absenceProbe).toContain('"${compose[@]}" ps -q app');
    expect(absenceProbe).toContain('curl --fail --silent --show-error --connect-timeout 1 "$base_url/api/health/live"');
    expect(script.indexOf('assert_app_absent', negativeProbeStart + 1)).toBeGreaterThan(negativeProbeStart);
    expect(script).toContain('/api/health/live');
    expect(script).toContain('/api/health/ready');
    expect(script).toContain("base_url='http://127.0.0.1:3000'");
    expect(script).not.toMatch(/(?:tianyi\.wiki|x\.tianyi\.wiki|https?:\/\/[^\s"']*(?:production|remote))/i);
  });

  it('checks hardened runtime state and named-volume persistence', async () => {
    // Break caught: a candidate can become root, writable at its root filesystem, or lose durable user data on restart.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain('id -u');
    expect(script).toContain('ReadonlyRootfs');
    expect(script).toContain('/data/avatars');
    expect(script).toContain('/data/backups');
    expect(script).toContain('restart app');
    expect(script).toMatch(/avatar-marker-\$\{marker\}/);
    expect(script).toMatch(/backup-marker-\$\{marker\}/);
    const restart = script.indexOf('"${compose[@]}" restart app');
    expect(script.indexOf('> /data/avatars/avatar-marker-${marker}')).toBeLessThan(restart);
    expect(script.indexOf('> /data/backups/backup-marker-${marker}')).toBeLessThan(restart);
    expect(script.indexOf('cat /data/avatars/avatar-marker-${marker}')).toBeGreaterThan(restart);
    expect(script.indexOf('cat /data/backups/backup-marker-${marker}')).toBeGreaterThan(restart);
  });

  it('uses production-like filesystem and privilege restrictions in test Compose', async () => {
    // Break caught: the candidate smoke does not exercise the image under the restrictions used in production.
    const compose = parse(await readRepositoryFile('docker-compose.test.yml')) as {
      services: { app: Record<string, unknown> };
    };

    expect(compose.services.app.read_only).toBe(true);
    expect(compose.services.app.tmpfs).toContain('/tmp:size=64m,mode=1777');
    expect(compose.services.app.security_opt).toContain('no-new-privileges:true');
    expect(compose.services.app.cap_drop).toContain('ALL');
    expect(compose.services.app.pull_policy).toBe('never');
    expect(compose.services.app.entrypoint).toEqual([]);
    expect(compose.services.app.command).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy && exec node apps/api/dist/main.js');
  });
});
