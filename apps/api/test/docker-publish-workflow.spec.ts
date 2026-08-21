import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function readRepositoryFile(path: string) {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string | boolean;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean | string;
};

type WorkflowJob = {
  needs?: string | string[];
  uses?: string;
  if?: string | boolean;
  "continue-on-error"?: boolean | string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  services?: Record<string, Record<string, unknown>>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

async function readWorkflow(name: string) {
  const source = await readRepositoryFile(`.github/workflows/${name}`);
  return { source, workflow: parse(source) as Workflow };
}

function stepsFor(workflow: Workflow, jobName: string) {
  const job = workflow.jobs?.[jobName];
  if (!job) throw new Error(`Missing required job: ${jobName}`);
  if (job.if !== undefined) throw new Error(`Required job is conditional: ${jobName}`);
  return job.steps ?? [];
}

function requiredStep(workflow: Workflow, jobName: string, stepName: string) {
  const matches = stepsFor(workflow, jobName).filter((step) => step.name === stepName);
  if (matches.length !== 1) throw new Error(`Expected one ${jobName}/${stepName} step`);
  const step = matches[0]!;
  if (step.if !== undefined) throw new Error(`Required step is conditional: ${jobName}/${stepName}`);
  if (step["continue-on-error"] !== undefined) {
    throw new Error(`Required step may continue on error: ${jobName}/${stepName}`);
  }
  return step;
}

function requiredRunStep(workflow: Workflow, jobName: string, stepName: string) {
  const step = requiredStep(workflow, jobName, stepName);
  if (typeof step.run !== "string") throw new Error(`Missing run script: ${jobName}/${stepName}`);
  return step;
}

function executableLines(step: WorkflowStep) {
  if (typeof step.run !== "string") return [];
  return step.run
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function lineIndex(lines: string[], matcher: string | RegExp) {
  return lines.findIndex((line) =>
    typeof matcher === "string" ? line === matcher : matcher.test(line),
  );
}

function actionReferences(workflow: Workflow) {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => [job.uses, ...(job.steps ?? []).map((step) => step.uses)])
    .filter((uses): uses is string => typeof uses === "string");
}

function expectDigestOnlyLatestPromotion(step: WorkflowStep) {
  const lines = executableLines(step);
  const createCommand =
    'docker buildx imagetools create --tag docker.io/tianyi920/poker-scorekeeper:latest "docker.io/tianyi920/poker-scorekeeper@$VERIFIED_DIGEST"';
  const inspectCommand =
    "docker buildx imagetools inspect --format '{{json .Manifest}}' docker.io/tianyi920/poker-scorekeeper:latest > latest-manifest.json";
  const digestExtraction =
    `LATEST_DIGEST="$(jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' latest-manifest.json)"`;
  const create = lineIndex(lines, createCommand);
  const inspect = lineIndex(lines, inspectCommand);
  const latestDigest = lineIndex(lines, digestExtraction);
  const equality = lineIndex(lines, '[[ "$LATEST_DIGEST" == "$VERIFIED_DIGEST" ]]');

  expect(lines.filter((line) => line.includes("imagetools create"))).toEqual([createCommand]);
  expect(lines.filter((line) => line.startsWith("LATEST_DIGEST="))).toEqual([
    digestExtraction,
  ]);
  expect(create).toBeGreaterThanOrEqual(0);
  expect(inspect).toBeGreaterThan(create);
  expect(latestDigest).toBeGreaterThan(inspect);
  expect(equality).toBeGreaterThan(latestDigest);
}

function requireTrackedSecretGate(workflow: Workflow) {
  const steps = stepsFor(workflow, "verify");
  const gate = requiredRunStep(
    workflow,
    "verify",
    "Scan tracked files for secrets",
  );
  if (executableLines(gate).join("\n") !== "node scripts/security/scan-tracked-secrets.mjs") {
    throw new Error("tracked secret scanner is not the active command");
  }
  if (
    steps.indexOf(gate) >=
    steps.indexOf(
      requiredRunStep(
        workflow,
        "verify",
        "Run the complete isolated container release drill",
      ),
    )
  ) {
    throw new Error("tracked secret scanner does not precede the container drill");
  }
  return gate;
}

describe("GitHub Actions Docker publication workflows", () => {
  it("keeps every job and step fail-closed under global read-only permissions", async () => {
    // Break caught: one job escalates permissions or a release/security gate is allowed to fail silently.
    for (const name of ["verify.yml", "publish-docker.yml", "promote-latest.yml"]) {
      const { workflow } = await readWorkflow(name);
      expect(workflow.permissions, `${name}: global permissions`).toEqual({ contents: "read" });
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        expect(job.permissions, `${name}/${jobName}: job permissions`).toBeUndefined();
        expect(job["continue-on-error"], `${name}/${jobName}: job continue-on-error`)
          .toBeUndefined();
        for (const step of job.steps ?? []) {
          expect(
            step["continue-on-error"],
            `${name}/${jobName}/${step.name ?? step.uses ?? "unnamed"}: step continue-on-error`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("makes verification reusable for pull requests and branch pushes with only read permission", async () => {
    // Break caught: an ordinary verification event can publish, receive write permission, or omit a required CI entry point.
    const { workflow } = await readWorkflow("verify.yml");

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_call",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(actionReferences(workflow)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^docker\/(?:login|build-push)-action@/),
      ]),
    );
    for (const step of stepsFor(workflow, "verify")) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(executableLines(step)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/imagetools create|docker push/)]),
      );
    }
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

    expect(executableLines(requiredRunStep(workflow, "verify", "Check guarded CI database connectivity")))
      .toContain("node scripts/database/run-with-ci-test-env.mjs --check-only");
    expect(executableLines(requiredRunStep(workflow, "verify", "Apply migrations to the isolated CI database")))
      .toContain("node scripts/database/run-with-ci-test-env.mjs pnpm --filter @poker/api prisma migrate deploy");
    expect(executableLines(requiredRunStep(workflow, "verify", "Run full package tests")))
      .toContain("node scripts/database/run-with-ci-test-env.mjs pnpm test");
    expect(executableLines(requiredRunStep(workflow, "verify", "Run API integration tests")))
      .toContain("node scripts/database/run-with-ci-test-env.mjs pnpm --filter @poker/api test:integration");
    expect(executableLines(requiredRunStep(workflow, "verify", "Run the 23-test browser suite")))
      .toContain("node scripts/database/run-with-ci-test-env.mjs pnpm exec playwright test");
  });

  it("runs the complete verification sequence and validates registry Compose with disposable example files", async () => {
    // Break caught: release verification skips a required suite or validates Compose with an undisclosed environment file.
    const { workflow } = await readWorkflow("verify.yml");
    const stepNames = stepsFor(workflow, "verify").map((step) => step.name);
    const ordered = [
      "Install frozen dependencies",
      "Check guarded CI database connectivity",
      "Apply migrations to the isolated CI database",
      "Lint and typecheck",
      "Run full package tests",
      "Run API integration tests",
      "Build all packages",
      "Install browser engines",
      "Run the 23-test browser suite",
      "Run the complete isolated container release drill",
      "Validate registry Compose and repository hygiene",
    ];
    let position = -1;
    for (const stepName of ordered) {
      requiredStep(workflow, "verify", stepName);
      const next = stepNames.indexOf(stepName);
      expect(next, stepName).toBeGreaterThan(position);
      position = next;
    }
    expect(executableLines(requiredRunStep(workflow, "verify", "Install frozen dependencies")))
      .toContain("pnpm install --frozen-lockfile");
    expect(executableLines(requiredRunStep(workflow, "verify", "Lint and typecheck")))
      .toEqual(expect.arrayContaining(["pnpm lint", "pnpm typecheck"]));
    expect(executableLines(requiredRunStep(workflow, "verify", "Install browser engines")))
      .toContain("pnpm exec playwright install --with-deps chromium webkit");
    expect(executableLines(requiredRunStep(workflow, "verify", "Build all packages")))
      .toContain("pnpm build");
    const containerDrill = requiredRunStep(
      workflow,
      "verify",
      "Run the complete isolated container release drill",
    );
    expect(executableLines(containerDrill)).toEqual([
      "pwsh -NoProfile -File scripts/verify-release.ps1 -ContainerOnly",
    ]);
    expect(containerDrill.run).not.toMatch(/run-with-test-env|\.env\.local/);
    const composeLines = executableLines(
      requiredRunStep(workflow, "verify", "Validate registry Compose and repository hygiene"),
    );
    expect(composeLines).toEqual(expect.arrayContaining([
      "rm -f test-results/extremespace-compose.env .env.production",
      "trap cleanup EXIT",
      "cp .env.extremespace.example test-results/extremespace-compose.env",
      "cp .env.extremespace.example .env.production",
      "docker compose --env-file test-results/extremespace-compose.env -f docker-compose.registry.yml config --quiet",
      "git diff --check",
    ]));
    expect(JSON.stringify(workflow)).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("runs the tracked-file secret gate unconditionally before Docker and publication", async () => {
    const { source, workflow } = await readWorkflow("verify.yml");
    expect(() => requireTrackedSecretGate(workflow)).not.toThrow();

    const disabled = parse(
      source.replace(
        "      - name: Scan tracked files for secrets",
        "      - name: Scan tracked files for secrets\n        if: false",
      ),
    ) as Workflow;
    expect(() => requireTrackedSecretGate(disabled)).toThrow(/conditional/);

    const commented = parse(
      source.replace(
        "          node scripts/security/scan-tracked-secrets.mjs",
        "          # node scripts/security/scan-tracked-secrets.mjs",
      ),
    ) as Workflow;
    expect(() => requireTrackedSecretGate(commented)).toThrow(/active command/);

    const publication = (await readWorkflow("publish-docker.yml")).workflow;
    expect(publication.jobs?.verify?.uses).toBe("./.github/workflows/verify.yml");
    expect(publication.jobs?.metadata?.needs).toBe("verify");
  });

  it("serializes each release ref and rechecks fixed-tag absence in the publishing job", async () => {
    // Break caught: concurrent runs or a failed-job rerun can overwrite a fixed tag after the early metadata preflight.
    const { workflow } = await readWorkflow("publish-docker.yml");
    const push = workflow.on?.push as { tags?: string[]; branches?: string[] };

    expect(Object.keys(workflow.on ?? {})).toEqual(["push"]);
    expect(push.tags).toEqual(["v*.*.*"]);
    expect(push.branches).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "poker-scorekeeper-publish-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs?.verify?.uses).toBe("./.github/workflows/verify.yml");
    expect(workflow.jobs?.metadata?.needs).toBe("verify");
    const metadataLines = executableLines(
      requiredRunStep(workflow, "metadata", "Validate immutable release metadata and fixed-tag absence"),
    );
    expect(metadataLines.some((line) => line.includes("docker-publish-contract.mjs metadata"))).toBe(true);
    expect(metadataLines).toContain(
      `sha_tag="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.shaTag)' "$metadata_json")"`,
    );
    expect(metadataLines).toContain(
      'node scripts/release/docker-publish-contract.mjs tag-absent tianyi920/poker-scorekeeper "$version"',
    );
    expect(metadataLines).toContain(
      'node scripts/release/docker-publish-contract.mjs tag-absent tianyi920/poker-scorekeeper "$sha_tag"',
    );

    const publishSteps = stepsFor(workflow, "publish");
    const recheck = requiredRunStep(
      workflow,
      "publish",
      "Recheck immutable-tag absence before publication",
    );
    expect(recheck.env).toEqual({
      VERSION: "${{ needs.metadata.outputs.version }}",
      COMMIT_TAG: "sha-${{ github.sha }}",
    });
    expect(executableLines(recheck)).toEqual([
      "set -euo pipefail",
      'node scripts/release/docker-publish-contract.mjs tag-absent tianyi920/poker-scorekeeper "$VERSION"',
      'node scripts/release/docker-publish-contract.mjs tag-absent tianyi920/poker-scorekeeper "$COMMIT_TAG"',
    ]);
    const recheckIndex = publishSteps.indexOf(recheck);
    const accountIndex = publishSteps.indexOf(
      requiredRunStep(workflow, "publish", "Refuse an unexpected Docker Hub account"),
    );
    const loginIndex = publishSteps.indexOf(requiredStep(workflow, "publish", "Log in to Docker Hub"));
    const pushIndex = publishSteps.indexOf(requiredStep(workflow, "publish", "Push fixed and full-commit tags"));
    expect([accountIndex, loginIndex, pushIndex]).toEqual([
      recheckIndex + 1,
      recheckIndex + 2,
      recheckIndex + 3,
    ]);
  });

  it("smokes one unique local amd64 candidate before pushing exactly two identified platforms", async () => {
    // Break caught: publication skips local runtime proof, smokes a pullable tag, or pushes an incomplete platform set.
    const { workflow } = await readWorkflow("publish-docker.yml");
    const candidateLines = executableLines(
      requiredRunStep(workflow, "candidate", "Build and smoke the unique amd64 candidate"),
    );
    const pushJob = workflow.jobs?.publish;
    const buildPush = requiredStep(workflow, "publish", "Push fixed and full-commit tags");

    expect(workflow.jobs?.candidate?.needs).toBe("metadata");
    expect(candidateLines).toEqual(expect.arrayContaining([
      "--platform linux/amd64 \\",
      '--build-arg "DEPLOYMENT_ID=$EXPECTED_COMMIT" \\',
      "bash scripts/ci/verify-candidate-image.sh",
    ]));
    expect(candidateLines.some((line) => /^POKER_TEST_IMAGE="poker-scorekeeper:candidate-/.test(line))).toBe(true);
    expect(candidateLines.some((line) => /^COMPOSE_PROJECT_NAME="poker-candidate-/.test(line))).toBe(true);
    expect(candidateLines.some((line) => /docker pull/.test(line))).toBe(false);
    expect(pushJob?.needs).toEqual(["metadata", "candidate"]);
    expect(buildPush.uses).toMatch(/^docker\/build-push-action@[0-9a-f]{40}$/);
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
    expect(JSON.stringify(workflow)).not.toMatch(/secrets\.(?!DOCKERHUB_(?:USERNAME|TOKEN))/);
  });

  it("binds all remote publication checks to one digest and re-reads both tags", async () => {
    // Break caught: tag mutation can switch the raw index or one platform config between separate verification commands.
    const { workflow } = await readWorkflow("publish-docker.yml");
    expect(workflow.jobs?.remote_verify?.needs).toBe("publish");
    const verifyStep = requiredRunStep(
      workflow,
      "remote_verify",
      "Verify the remote index and both platform identities",
    );
    expect(verifyStep.env).toEqual({
      FIXED_IMAGE: "docker.io/tianyi920/poker-scorekeeper:${{ needs.publish.outputs.version }}",
      COMMIT_IMAGE: "docker.io/tianyi920/poker-scorekeeper:sha-${{ github.sha }}",
    });
    const lines = executableLines(verifyStep);
    const fixedDigest = lineIndex(lines, /^VERIFIED_DIGEST=/);
    const commitDigest = lineIndex(lines, /^COMMIT_DIGEST=/);
    const digestEquality = lineIndex(lines, '[[ "$COMMIT_DIGEST" == "$VERIFIED_DIGEST" ]]');
    const digestImage = lineIndex(lines, 'DIGEST_IMAGE="${IMAGE_REPOSITORY}@${VERIFIED_DIGEST}"');
    const raw = lineIndex(lines, 'docker buildx imagetools inspect --raw "$DIGEST_IMAGE" > raw-index.json');
    const manifest = lineIndex(
      lines,
      "node scripts/release/docker-publish-contract.mjs manifest raw-index.json",
    );
    const identity = lineIndex(
      lines,
      'node scripts/release/docker-publish-contract.mjs identity platform-identities.json "$GITHUB_SHA"',
    );
    expect(fixedDigest).toBeGreaterThanOrEqual(0);
    expect(commitDigest).toBeGreaterThan(fixedDigest);
    expect(digestEquality).toBeGreaterThan(commitDigest);
    expect(digestImage).toBeGreaterThan(digestEquality);
    expect(raw).toBeGreaterThan(digestImage);
    expect(manifest).toBeGreaterThan(raw);
    expect(identity).toBeGreaterThan(manifest);
    expect(lines.filter((line) => line.includes("(index .Image"))).toEqual([
      'docker buildx imagetools inspect --format \'{{json (index .Image "linux/amd64")}}\' "$DIGEST_IMAGE" > amd64-image.json',
      'docker buildx imagetools inspect --format \'{{json (index .Image "linux/arm64")}}\' "$DIGEST_IMAGE" > arm64-image.json',
    ]);
    expect(lines.filter((line) => line.includes("imagetools inspect --raw"))).toEqual([
      'docker buildx imagetools inspect --raw "$DIGEST_IMAGE" > raw-index.json',
    ]);
    const finalFixed = lineIndex(lines, /"\$FIXED_IMAGE" > fixed-manifest-final\.json$/);
    const finalCommit = lineIndex(lines, /"\$COMMIT_IMAGE" > commit-manifest-final\.json$/);
    const finalFixedEquality = lineIndex(lines, '[[ "$FINAL_FIXED_DIGEST" == "$VERIFIED_DIGEST" ]]');
    const finalCommitEquality = lineIndex(lines, '[[ "$FINAL_COMMIT_DIGEST" == "$VERIFIED_DIGEST" ]]');
    expect(finalFixed).toBeGreaterThan(identity);
    expect(finalCommit).toBeGreaterThan(finalFixed);
    expect(finalFixedEquality).toBeGreaterThan(finalCommit);
    expect(finalCommitEquality).toBeGreaterThan(finalFixedEquality);

    expect(workflow.jobs?.promote_latest?.needs).toBe("remote_verify");
    const promotion = requiredRunStep(
      workflow,
      "promote_latest",
      "Promote only the verified digest to latest",
    );
    expectDigestOnlyLatestPromotion(promotion);
    expect(executableLines(promotion).some((line) => /docker (?:build|push)(?:\s|$)/.test(line)))
      .toBe(false);
  });

  it("checks the expected Docker Hub account in every authenticating job", async () => {
    // Break caught: a new or moved login step can bypass the non-secret account-identity guard.
    for (const [workflowName, expectedJobs] of [
      ["publish-docker.yml", ["publish", "promote_latest"]],
      ["promote-latest.yml", ["promote"]],
    ] as const) {
      const { workflow } = await readWorkflow(workflowName);
      const actualJobs: string[] = [];
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        for (let loginIndex = 0; loginIndex < steps.length; loginIndex += 1) {
          const login = steps[loginIndex]!;
          if (!login.uses?.startsWith("docker/login-action@")) continue;
          actualJobs.push(jobName);
          expect(login.if).toBeUndefined();
          expect(login["continue-on-error"]).toBeUndefined();
          const guard = steps[loginIndex - 1];
          if (!guard) throw new Error(`Missing account guard before ${workflowName}/${jobName}`);
          expect(guard.name).toBe("Refuse an unexpected Docker Hub account");
          expect(guard.if).toBeUndefined();
          expect(guard["continue-on-error"]).toBeUndefined();
          expect(guard.env).toEqual({
            DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
          });
          const guardLines = executableLines(guard);
          expect(guardLines).toContain('[[ "$DOCKERHUB_USERNAME" == \'tianyi920\' ]] || {');
          expect(guardLines.some((line) => /(?:echo|printf).*DOCKERHUB_USERNAME/.test(line))).toBe(false);
        }
      }
      expect(actualJobs.sort()).toEqual([...expectedJobs].sort());
    }
  });

  it("binds recovery identity and tag rechecks to the fixed digest", async () => {
    // Break caught: recovery can validate one tag resolution but promote a digest whose platform identity came from another.
    const { workflow } = await readWorkflow("promote-latest.yml");
    const dispatch = workflow.on?.workflow_dispatch as {
      inputs?: Record<string, Record<string, unknown>>;
    };

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(dispatch.inputs?.version).toEqual(
      expect.objectContaining({ required: true, type: "string" }),
    );
    expect(workflow.permissions).toEqual({ contents: "read" });
    const validate = requiredRunStep(workflow, "validate", "Revalidate fixed image provenance");
    const lines = executableLines(validate);
    expect(lines.some((line) => /\^\(0\|\[1-9\]\[0-9\]\*\)\\\./.test(line))).toBe(true);
    const fixedDigest = lineIndex(lines, /^FIXED_DIGEST=/);
    const digestImage = lineIndex(lines, 'DIGEST_IMAGE="${IMAGE_REPOSITORY}@${FIXED_DIGEST}"');
    const raw = lineIndex(lines, 'docker buildx imagetools inspect --raw "$DIGEST_IMAGE" > raw-index.json');
    const manifest = lineIndex(
      lines,
      "node scripts/release/docker-publish-contract.mjs manifest raw-index.json",
    );
    const identity = lineIndex(
      lines,
      'node scripts/release/docker-publish-contract.mjs identity platform-identities.json "$EXPECTED_COMMIT"',
    );
    const shaDigest = lineIndex(lines, /^SHA_DIGEST=/);
    const digestEquality = lineIndex(lines, '[[ "$SHA_DIGEST" == "$FIXED_DIGEST" ]]');
    expect(fixedDigest).toBeGreaterThanOrEqual(0);
    expect(digestImage).toBeGreaterThan(fixedDigest);
    expect(raw).toBeGreaterThan(digestImage);
    expect(manifest).toBeGreaterThan(raw);
    expect(identity).toBeGreaterThan(manifest);
    expect(shaDigest).toBeGreaterThan(identity);
    expect(digestEquality).toBeGreaterThan(shaDigest);
    expect(lines.filter((line) => line.includes("(index .Image"))).toEqual([
      'docker buildx imagetools inspect --format \'{{json (index .Image "linux/amd64")}}\' "$DIGEST_IMAGE" > amd64-image.json',
      'docker buildx imagetools inspect --format \'{{json (index .Image "linux/arm64")}}\' "$DIGEST_IMAGE" > arm64-image.json',
    ]);
    const finalFixed = lineIndex(lines, /"\$FIXED_IMAGE" > fixed-manifest-final\.json$/);
    const finalSha = lineIndex(lines, /"\$SHA_IMAGE" > sha-manifest-final\.json$/);
    const finalFixedEquality = lineIndex(lines, '[[ "$FINAL_FIXED_DIGEST" == "$FIXED_DIGEST" ]]');
    const finalShaEquality = lineIndex(lines, '[[ "$FINAL_SHA_DIGEST" == "$FIXED_DIGEST" ]]');
    expect(finalFixed).toBeGreaterThan(digestEquality);
    expect(finalSha).toBeGreaterThan(finalFixed);
    expect(finalFixedEquality).toBeGreaterThan(finalSha);
    expect(finalShaEquality).toBeGreaterThan(finalFixedEquality);

    const promotion = requiredRunStep(workflow, "promote", "Promote only the revalidated digest");
    expectDigestOnlyLatestPromotion(promotion);
    expect(actionReferences(workflow).some((uses) => uses.startsWith("docker/build-push-action@")))
      .toBe(false);
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
  it('rejects fragmented images and verifies every startup-critical file before database work', async () => {
    // Break caught: a registry image can pass a normal build while a NAS runtime drops late filesystem layers.
    const script = await readRepositoryFile('scripts/ci/verify-candidate-image.sh');

    expect(script).toContain("max_image_layers=16");
    expect(script).toContain("{{ len .RootFS.Layers }}");
    expect(script).toContain('docker run --rm --pull never --entrypoint /bin/sh');
    for (const requiredPath of [
      '/app/apps/api/dist/main.js',
      '/app/apps/web/dist/index.html',
      '/app/prisma-schema-engine',
      '/app/apps/api/node_modules/.bin/prisma',
      '/app/scripts/docker/entrypoint.sh',
      '/app/scripts/docker/healthcheck.mjs',
      '/app/scripts/database/production-preflight.mjs',
      '/app/scripts/database/create-database.mjs',
      '/app/scripts/database/production-backup-target.mjs',
      '/app/scripts/database/assert-production-avatar-files.mjs',
      '/app/scripts/database/production-migration-evidence.mjs',
      '/app/scripts/backup/backup.sh',
      '/app/scripts/backup/restore.sh',
      '/app/scripts/backup/restore-input-guard.mjs',
    ]) {
      expect(script, requiredPath).toContain(requiredPath);
    }
    expect(script.indexOf('max_image_layers=16')).toBeLessThan(
      script.indexOf('docker pull mysql:8.4'),
    );
  });

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
    expect(script.match(/^docker pull mysql:8\.4$/gm)).toHaveLength(1);
    expect(script).not.toContain('docker pull "$POKER_TEST_IMAGE"');
    expect(script.indexOf('docker pull mysql:8.4')).toBeLessThan(
      script.indexOf('"${compose[@]}" up -d --pull never --no-build mysql'),
    );
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
    expect(negativeProbe).toContain('app /app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts');
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
    expect(script).toContain('/api/health/deployment');
    expect(script).toContain('scripts/release/assert-deployment-response.mjs');
    expect(script).toContain('EXPECTED_DEPLOYMENT_ID="$EXPECTED_COMMIT"');
    expect(script.match(/^assert_deployment_identity$/gm)).toHaveLength(2);
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
    expect(compose.services.app.command).toContain('/app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts && exec node apps/api/dist/main.js');
  });
});
