import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const probePath = resolve(
  repositoryRoot,
  "scripts/release/assert-deployment-response.mjs",
);
const commit = "0123456789abcdef0123456789abcdef01234567";

function probe(expectedDeploymentId: string | undefined, response: unknown) {
  const environment = { ...process.env };
  if (expectedDeploymentId === undefined) {
    delete environment.EXPECTED_DEPLOYMENT_ID;
  } else {
    environment.EXPECTED_DEPLOYMENT_ID = expectedDeploymentId;
  }
  return spawnSync(process.execPath, [probePath], {
    input: typeof response === "string" ? response : JSON.stringify(response),
    env: environment,
    encoding: "utf8",
  });
}

describe("deployment identity response probe", () => {
  it.each([commit, "releaseverify-0123456789ab-deadbeef"])(
    "accepts only the exact expected deployment ID %s",
    (expectedDeploymentId) => {
      const result = probe(expectedDeploymentId, {
        deploymentId: expectedDeploymentId,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    [undefined, { deploymentId: commit }],
    [commit, { deploymentId: "fedcba9876543210fedcba9876543210fedcba98" }],
    [commit, { deploymentId: commit, unexpected: true }],
    [commit, "not-json"],
  ])(
    "fails closed for missing, mismatched, or malformed identity %#",
    (expected, body) => {
      const result = probe(expected, body);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("DEPLOYMENT_IDENTITY_MISMATCH");
      expect(`${result.stdout}${result.stderr}`).not.toContain(commit);
      expect(`${result.stdout}${result.stderr}`).not.toContain("fedcba");
    },
  );
});
