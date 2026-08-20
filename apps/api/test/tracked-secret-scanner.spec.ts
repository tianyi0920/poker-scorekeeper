import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const scannerPath = resolve(
  repositoryRoot,
  "scripts/security/scan-tracked-secrets.mjs",
);
const temporaryRoots: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tracked-secret-scan-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function track(root: string, path: string): void {
  execFileSync("git", ["add", "--", path], { cwd: root });
}

function scan(root: string) {
  return spawnSync(process.execPath, [scannerPath], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("tracked-file secret scanner", () => {
  it("accepts placeholders and ignores an untracked credential", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, ".env.example"),
      [
        "SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
        "DATABASE_URL=mysql://example:example@localhost:3306/example_test",
        "PUBLIC_API_TOKEN=public_example_token",
      ].join("\n"),
    );
    track(root, ".env.example");

    const untrackedCredential = `ghp_${"A".repeat(36)}`;
    await writeFile(
      join(root, ".env.local"),
      `API_TOKEN=${untrackedCredential}\n`,
    );

    const result = scan(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Scanned 1 tracked file");
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      untrackedCredential,
    );
  });

  it("rejects known token formats without printing the matched value", async () => {
    const root = await createRepository();
    const credential = `ghp_${"B".repeat(36)}`;
    await writeFile(join(root, "tracked.env"), `API_TOKEN=${credential}\n`);
    track(root, "tracked.env");

    const result = scan(root);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("tracked.env:1");
    expect(output).toContain("github-token");
    expect(output).not.toContain(credential);
  });

  it("rejects a high-confidence sensitive assignment and reports only location", async () => {
    const root = await createRepository();
    const credential = "Z9!a".repeat(12);
    await writeFile(
      join(root, "production.env"),
      `SESSION_SECRET=${credential}\n`,
    );
    track(root, "production.env");

    const result = scan(root);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("production.env:1");
    expect(output).toContain("sensitive-assignment");
    expect(output).not.toContain(credential);
  });

  it("does not allow an example credential in a production configuration", async () => {
    const root = await createRepository();
    await writeFile(
      join(root, "production.env"),
      "DATABASE_URL=mysql://user:secret@database.internal:3306/poker\n",
    );
    track(root, "production.env");

    const result = scan(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("credential-url");
  });
});
