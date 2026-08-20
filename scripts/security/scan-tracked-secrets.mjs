import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const knownSecretPatterns = [
  {
    rule: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  { rule: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { rule: "docker-token", pattern: /\bdckr_pat_[A-Za-z0-9_-]{24,}\b/g },
  { rule: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { rule: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
];

const publicIsolatedFixtureValues = new Set([
  "ci_only_session_secret_0123456789abcdef0123456789abcdef",
  "ci_only_csrf_secret_0123456789abcdef0123456789abcdef",
  "ci_only_mysql_root_password",
  "CI-only-password-12345",
  "test_only_change_me_0123456789abcdef0123456789abcdef",
  "Test-only-password-12345",
  "poker_ci",
  "poker_test",
  "poker_test_root",
  "test_root_only",
]);

const exampleFixtureValues = new Set([
  "secret",
  "hidden",
  "poisoned",
  "leaked-secret",
  "top-secret",
  "u",
  "p",
]);

function isExampleFixturePath(path) {
  return (
    /(?:^|\/)(?:test|tests)\//.test(path) ||
    /\.(?:test|spec)\.[^/]+$/.test(path) ||
    path.startsWith("docs/superpowers/plans/")
  );
}

function isPublicIsolatedFixturePath(path) {
  return (
    path === ".github/workflows/verify.yml" ||
    path === "docker-compose.test.yml" ||
    path === "scripts/database/ci-test-environment.mjs" ||
    isExampleFixturePath(path)
  );
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

function normalizeAssignmentValue(rawValue) {
  const withoutComment = rawValue
    .trim()
    .replace(/\s+(?:#|\/\/).*$/, "")
    .trim();
  return withoutComment
    .replace(/[,;]$/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function isApprovedNonSecret(path, value) {
  if (value === "") return true;
  if (/^CHANGE_ME(?:_[A-Z0-9_]+)?$/i.test(value)) return true;
  if (/^replace(?:[_-]?(?:me|with))(?:[_-][A-Z0-9_]+)*$/i.test(value))
    return true;
  if (/^<[^>]+>$/.test(value)) return true;
  if (/^(?:example|public_example)(?:[_-][A-Z0-9_]+)*$/i.test(value))
    return true;
  if (/^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/.test(value)) return true;
  if (/^\$\{?[A-Z][A-Z0-9_]*(?::[-?][^}]*)?\}?$/.test(value)) return true;
  if (
    isPublicIsolatedFixturePath(path) &&
    publicIsolatedFixtureValues.has(value)
  ) {
    return true;
  }
  return isExampleFixturePath(path) && exampleFixtureValues.has(value);
}

function isStrictConfigurationPath(path) {
  const name = basename(path);
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".env") ||
    /\.(?:ya?ml|md|toml|ini)$/i.test(path)
  );
}

function isHighConfidenceLiteral(value) {
  if (value.length < 32 || /\s/.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(
    (pattern) => pattern.test(value),
  ).length;
  return classes >= 2;
}

function scanText(path, content) {
  const findings = [];
  for (const { rule, pattern } of knownSecretPatterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({ path, line: lineNumberAt(content, match.index), rule });
    }
  }

  const lines = content.split(/\r?\n/);
  const strict = isStrictConfigurationPath(path);
  for (const [index, line] of lines.entries()) {
    const assignment = line.match(
      /^\s*(?:(?:\/\/|#)\s*)?(?:-\s*)?(?:(?:export\s+)?(?:const|let|var)\s+|export\s+)?(?:["']?)((?:[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)|PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY)|DATABASE_URL)(?:["']?)\s*[:=]\s*(.*)$/,
    );
    if (!assignment) continue;
    const value = normalizeAssignmentValue(assignment[2]);
    if (isApprovedNonSecret(path, value)) continue;

    let credentialUrl = false;
    const isDatabaseUrl = assignment[1] === "DATABASE_URL";
    if (isDatabaseUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        const password = decodeURIComponent(url.password);
        if (password === "" || isApprovedNonSecret(path, password)) continue;
        credentialUrl = true;
      } catch {
        credentialUrl = true;
      }
    }
    if (
      credentialUrl ||
      (!isDatabaseUrl &&
        ((strict && !/^\$|^(?:process|environment)\./.test(value)) ||
          isHighConfidenceLiteral(value)))
    ) {
      findings.push({
        path,
        line: index + 1,
        rule: credentialUrl ? "credential-url" : "sensitive-assignment",
      });
    }
  }

  const unique = new Map();
  for (const finding of findings) {
    unique.set(`${finding.path}\0${finding.line}\0${finding.rule}`, finding);
  }
  return [...unique.values()];
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function main() {
  let paths;
  try {
    paths = trackedFiles();
  } catch {
    process.stderr.write("Tracked-file enumeration failed\n");
    process.exitCode = 1;
    return;
  }

  const findings = [];
  let textFileCount = 0;
  for (const path of paths) {
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      process.stderr.write(`Tracked file could not be read: ${path}\n`);
      process.exitCode = 1;
      return;
    }
    if (buffer.includes(0)) continue;
    textFileCount += 1;
    findings.push(...scanText(path, buffer.toString("utf8")));
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `Potential secret detected in ${finding.path}:${finding.line} (${finding.rule})\n`,
      );
    }
    process.stderr.write(
      `Secret scan failed with ${findings.length} finding(s)\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Scanned ${textFileCount} tracked file${textFileCount === 1 ? "" : "s"}; no high-confidence secrets found\n`,
  );
}

main();
