import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { parse } from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface ComposeService {
  build?: { args?: Record<string, string> };
  image?: string;
  restart?: string;
  ports?: unknown;
  env_file?: unknown;
  volumes?: unknown;
  read_only?: boolean;
  tmpfs?: unknown;
  healthcheck?: unknown;
  security_opt?: string[];
  cap_drop?: string[];
  sysctls?: Record<string, string> | string[];
  environment?: Record<string, string>;
  entrypoint?: unknown;
  command?: unknown;
  networks?: string[];
}

async function readRepositoryFile(path: string): Promise<string> {
  return (await readFile(resolve(repositoryRoot, path), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

function validateActiveGuideMigrationCommands(guides: string[]): void {
  const commands = guides.flatMap((guide) =>
    guide
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("docker compose ") &&
          line.includes("prisma migrate deploy"),
      ),
  );
  if (commands.length < 2) {
    throw new Error("active deployment guides are missing migration commands");
  }
  for (const command of commands) {
    if (
      !command.endsWith(
        " app /app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts",
      ) ||
      command.includes("pnpm")
    ) {
      throw new Error("active deployment guide uses a runtime package manager");
    }
  }
}

function validateGeneratedOutputExclusions(content: string): void {
  const rules = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const directory of ["test-results", "playwright-report"]) {
    const exclusion = `${directory}/`;
    const exclusionIndex = rules.lastIndexOf(exclusion);
    if (exclusionIndex < 0) {
      throw new Error(`missing generated-output exclusion: ${exclusion}`);
    }
    if (
      rules
        .slice(exclusionIndex + 1)
        .some(
          (rule) =>
            rule === `!${directory}` || rule.startsWith(`!${directory}/`),
        )
    ) {
      throw new Error(`generated output is re-included: ${directory}`);
    }
  }
}

const inContainerReleaseHelpers = [
  "scripts/backup/backup.sh",
  "scripts/backup/restore.sh",
  "scripts/database/assert-restored-data.mjs",
  "scripts/database/seed-release-drill.mjs",
] as const;

const testOnlyReleaseHelpers = [
  "scripts/database/assert-restored-data.mjs",
  "scripts/database/seed-release-drill.mjs",
] as const;

function validateReleaseHelperAvailability(input: {
  release: string;
  dockerfile: string;
  testCompose: string;
  productionComposes: string[];
  trackedFiles: Set<string>;
}): void {
  const runtime = input.dockerfile.slice(
    input.dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
  );
  if (!runtime.startsWith("FROM node:24-bookworm-slim AS runtime")) {
    throw new Error("runtime stage is missing");
  }
  if (!/^WORKDIR \/app$/m.test(runtime)) {
    throw new Error("runtime workdir does not anchor relative helper paths");
  }

  const bundleStart = input.dockerfile.indexOf(
    "FROM production-dependencies AS runtime-bundle",
  );
  const applicationAssembly =
    bundleStart >= 0
      ? input.dockerfile.slice(
          bundleStart,
          input.dockerfile.indexOf(
            "FROM node:24-bookworm-slim AS runtime",
            bundleStart,
          ),
        )
      : runtime;
  const runtimeCopies = new Map<string, string>();
  for (const line of applicationAssembly.split(/\r?\n/)) {
    const copy = line.match(
      /^COPY(?:\s+--\S+)*\s+(.+?)\s+((?:\.\/|\/app\/)scripts\/\S+)$/,
    );
    if (!copy?.[1] || !copy[2]) continue;

    const sources = copy[1]
      .split(/\s+/)
      .filter((source) => source.startsWith("scripts/"));
    const destination = copy[2].replace(/^\.\//, "/app/");
    for (const source of sources) {
      const target = destination.endsWith("/")
        ? `${destination}${source.slice(source.lastIndexOf("/") + 1)}`
        : destination;
      runtimeCopies.set(source, target);
    }
  }

  const compose = parse(input.testCompose) as {
    services?: { app?: { volumes?: unknown } };
  };
  const volumes = compose.services?.app?.volumes;
  if (!Array.isArray(volumes)) throw new Error("test app volumes are missing");
  const scriptMounts = volumes.filter(
    (volume): volume is string =>
      typeof volume === "string" &&
      (volume.startsWith("./scripts/") || volume.includes(":/app/scripts/")),
  );
  if (scriptMounts.length !== testOnlyReleaseHelpers.length) {
    throw new Error("test Compose must expose exactly two helper files");
  }

  const mountedHelpers = new Map<string, string>();
  for (const mount of scriptMounts) {
    const parts = mount.split(":");
    if (parts.length !== 3 || parts[2] !== "ro") {
      throw new Error("verification helper mount must be read-only");
    }
    const source = parts[0]?.replace(/^\.\//, "");
    const target = parts[1];
    if (!source || !target || target !== `/app/${source}`) {
      throw new Error("verification helper mount target must match its source");
    }
    if (!input.trackedFiles.has(source)) {
      throw new Error("verification helper source must be tracked");
    }
    mountedHelpers.set(source, target);
  }

  for (const helper of inContainerReleaseHelpers) {
    if (!input.release.includes(helper)) {
      throw new Error(`release drill does not invoke ${helper}`);
    }
    if (!runtimeCopies.has(helper) && !mountedHelpers.has(helper)) {
      throw new Error(`release helper is unavailable in the app: ${helper}`);
    }
  }
  for (const helper of testOnlyReleaseHelpers) {
    if (runtime.includes(helper)) {
      throw new Error(`test-only helper leaked into runtime image: ${helper}`);
    }
    if (!mountedHelpers.has(helper)) {
      throw new Error(`test-only helper lacks an exact mount: ${helper}`);
    }
    const parent = `/app/${helper.slice(0, helper.lastIndexOf("/"))}/`;
    if (
      ![...runtimeCopies.values()].some((target) => target.startsWith(parent))
    ) {
      throw new Error(
        `runtime does not create helper target parent: ${parent}`,
      );
    }
  }

  if (
    !/\$compose \+ @\('exec',[^\r\n]+app[^\r\n]+seed-release-drill\.mjs/.test(
      input.release,
    ) ||
    !/\$compose \+ @\('run',[^\r\n]+app[^\r\n]+assert-restored-data\.mjs/.test(
      input.release,
    )
  ) {
    throw new Error("release helpers do not use the mounted app service");
  }

  for (const productionCompose of input.productionComposes) {
    if (
      /\.\/scripts(?:\/|:)/.test(productionCompose) ||
      testOnlyReleaseHelpers.some((helper) =>
        productionCompose.includes(helper),
      )
    ) {
      throw new Error("test-only helper leaked into production Compose");
    }
  }
}

const approvedSensitiveValues = {
  DATABASE_URL:
    "mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper",
  SESSION_SECRET: "CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
  CSRF_SECRET: "CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
  BOOTSTRAP_ADMIN_PASSWORD: "CHANGE_ME_UNIQUE_STRONG_PASSWORD",
  MYSQL_PASSWORD: "CHANGE_ME",
} as const;

const approvedEnvironmentKeys = [
  "POKER_IMAGE_VERSION",
  "PORT",
  "PUBLIC_ORIGIN",
  "WS_ALLOWED_ORIGINS",
  "DATABASE_URL",
  "SESSION_SECRET",
  "CSRF_SECRET",
  "BOOTSTRAP_ADMIN_USERNAME",
  "BOOTSTRAP_ADMIN_NICKNAME",
  "BOOTSTRAP_ADMIN_PASSWORD",
  "READINESS_TIMEOUT_MS",
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
  "BACKUP_DIR",
  "AVATAR_ROOT",
] as const;

const approvedEnvironmentComments = new Set([
  "# Fixed public image version pulled by docker-compose.registry.yml.",
  "# Optional comma-separated exact origins for additional trusted browser entry points.",
  "# Backup jobs reuse container environment so passwords never appear in command arguments.",
]);

function validateExtremeSpaceEnvironmentTemplate(
  content: string,
): Record<string, string> {
  const values = parseDotenv(content);
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const assignmentKeys: string[] = [];
  const approvedKeySet = new Set<string>(approvedEnvironmentKeys);

  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (!approvedEnvironmentComments.has(line))
        throw new Error("unapproved comment");
      continue;
    }

    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!assignment) throw new Error("unrecognized template line");
    const key = assignment[1]!;
    const rawValue = assignment[2]!;
    if (!approvedKeySet.has(key)) throw new Error("unapproved assignment key");
    assignmentKeys.push(key);

    const expected =
      approvedSensitiveValues[key as keyof typeof approvedSensitiveValues];
    if (expected !== undefined && rawValue !== expected) {
      throw new Error("unexpected sensitive assignment value");
    }
  }

  const expectedKeys = [...approvedEnvironmentKeys].sort();
  const actualKeys = [...assignmentKeys].sort();
  if (
    assignmentKeys.length !== approvedEnvironmentKeys.length ||
    new Set(assignmentKeys).size !== assignmentKeys.length ||
    actualKeys.join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error("missing or duplicate assignment key");
  }

  const parsedKeys = Object.keys(values).sort();
  if (parsedKeys.join("\n") !== expectedKeys.join("\n")) {
    throw new Error("dotenv keys do not match the closed-world template");
  }

  for (const [key, expected] of Object.entries(approvedSensitiveValues)) {
    if (values[key] !== expected)
      throw new Error(`unexpected placeholder for ${key}`);
  }

  const approvedDatabaseLine = `DATABASE_URL=${approvedSensitiveValues.DATABASE_URL}`;
  const mysqlLines = lines.filter((line) => /mysql:\/\//i.test(line));
  const mysqlLine = mysqlLines[0];
  if (
    mysqlLines.length !== 1 ||
    mysqlLine === undefined ||
    mysqlLine.trim() !== approvedDatabaseLine
  ) {
    throw new Error("unexpected credential-bearing mysql URL");
  }

  return values;
}

function validateExtremeSpaceRunbook(content: string): void {
  const requiredSnippets = [
    "将 `/path/selected-in-extremespace/poker-scorekeeper` 替换为你在极空间实际选择的目录",
    "export POKER_DIR=/path/selected-in-extremespace/poker-scorekeeper",
    "export EXISTING_AVATAR_DIR=/path/to/current-avatar-store-or-REUSE-or-NONE",
    'mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    'sudo cp -a "$EXISTING_AVATAR_DIR"/. "$POKER_DIR/data/avatars"/',
    'sudo diff -qr "$EXISTING_AVATAR_DIR" "$POKER_DIR/data/avatars"',
    'cd "$POKER_DIR"',
    'sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    'sudo chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    "运行镜像最终以 UID/GID `1000:1000` 的 `node` 用户运行",
    "在管理界面复核三项权限已生效",
    "docker compose --env-file .env.production -f docker-compose.registry.yml logs --tail=100 app",
    "curl --fail http://127.0.0.1:80/api/health/live",
    "curl --fail http://127.0.0.1:80/api/health/ready",
    "curl --fail http://127.0.0.1:80/api/health/deployment",
    "点击“应用”前，必须先完成第 3.1 节",
    "只选择一种正式启动方式",
    "不要再执行 Compose 的 `up -d`",
    "升级单独创建的容器时",
    "回滚单独创建的容器时",
    "http://pk.tianyi.wiki",
    "AAAA",
    "公网 IPv6",
    "TCP 80",
    "HTTP 明文",
    "WebSocket",
    "### 3.1 立即创建并验证首次备份",
    ': "${POKER_DIR:?Repeat section 1 in this shell first}"',
    'BACKUP_STAMP_BEFORE="$(sudo cat "$POKER_DIR/data/backups/latest-stamp" 2>/dev/null || true)"',
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/production-backup-target.mjs",
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs",
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app",
    'STAMP="$(sudo cat "$POKER_DIR/data/backups/latest-stamp")"',
    'test -z "$BACKUP_STAMP_BEFORE" || test "$STAMP" != "$BACKUP_STAMP_BEFORE"',
    'sudo test -f "$POKER_DIR/data/backups/mysql-$STAMP.sql.gz"',
    'sudo test -f "$POKER_DIR/data/backups/avatars-$STAMP.tar.gz"',
    'sudo test -f "$POKER_DIR/data/backups/manifest-$STAMP.txt"',
    'sudo test -f "$POKER_DIR/data/backups/checksums-$STAMP.txt"',
    'sudo sh -c \'cd "$1" && sha256sum --check "$2"\' sh "$POKER_DIR/data/backups" "checksums-$STAMP.txt"',
    "备份或四件套/校验任一步失败即停止升级",
    "POKER_IMAGE_VERSION=1.0.2 # previous fixed version",
    "forward-only",
    "does not roll back the schema",
  ];
  for (const required of requiredSnippets) {
    if (!content.includes(required))
      throw new Error(`missing Extreme Space runbook requirement: ${required}`);
  }

  const aclFallback =
    content.match(/若极空间共享目录的 ACL 覆盖传统权限，[^。]*。/)?.[0] ?? "";
  const aclRequirements = [
    /ACL 覆盖传统权限/,
    /UID\/GID `1000:1000`/,
    /"\$POKER_DIR"\/data\/avatars/,
    /"\$POKER_DIR"\/data\/backups/,
    /"\$POKER_DIR"\/data\/restore/,
    /读、写和进入权限/,
    /管理界面复核三项权限已生效/,
  ];
  if (aclRequirements.some((requirement) => !requirement.test(aclFallback))) {
    throw new Error("ACL fallback is not specific enough to apply and verify");
  }

  const shellBlocks = [...content.matchAll(/```sh\r?\n([\s\S]*?)```/g)].map(
    (match) => match[1]!,
  );
  const shellCommands = shellBlocks.flatMap((block) => block.split(/\r?\n/));
  const indexOfCommand = (command: string) =>
    shellCommands.findIndex((line) => line.trim() === command);
  const orderedCommandPairs: ReadonlyArray<readonly [string, string]> = [
    [
      "export POKER_DIR=/path/selected-in-extremespace/poker-scorekeeper",
      "export EXISTING_AVATAR_DIR=/path/to/current-avatar-store-or-REUSE-or-NONE",
    ],
    [
      "export EXISTING_AVATAR_DIR=/path/to/current-avatar-store-or-REUSE-or-NONE",
      'mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    ],
    [
      'mkdir -p "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
      'sudo cp -a "$EXISTING_AVATAR_DIR"/. "$POKER_DIR/data/avatars"/',
    ],
    [
      'sudo cp -a "$EXISTING_AVATAR_DIR"/. "$POKER_DIR/data/avatars"/',
      'sudo diff -qr "$EXISTING_AVATAR_DIR" "$POKER_DIR/data/avatars"',
    ],
    [
      'sudo diff -qr "$EXISTING_AVATAR_DIR" "$POKER_DIR/data/avatars"',
      'sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    ],
    [
      'sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
      'sudo chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
    ],
    [
      'BACKUP_STAMP_BEFORE="$(sudo cat "$POKER_DIR/data/backups/latest-stamp" 2>/dev/null || true)"',
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/production-backup-target.mjs",
    ],
    [
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/production-backup-target.mjs",
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs",
    ],
    [
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs",
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app",
    ],
    [
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app",
      'STAMP="$(sudo cat "$POKER_DIR/data/backups/latest-stamp")"',
    ],
    [
      'STAMP="$(sudo cat "$POKER_DIR/data/backups/latest-stamp")"',
      'sudo test -f "$POKER_DIR/data/backups/mysql-$STAMP.sql.gz"',
    ],
    [
      'sudo test -f "$POKER_DIR/data/backups/mysql-$STAMP.sql.gz"',
      'sudo test -f "$POKER_DIR/data/backups/avatars-$STAMP.tar.gz"',
    ],
    [
      'sudo test -f "$POKER_DIR/data/backups/avatars-$STAMP.tar.gz"',
      'sudo test -f "$POKER_DIR/data/backups/manifest-$STAMP.txt"',
    ],
    [
      'sudo test -f "$POKER_DIR/data/backups/manifest-$STAMP.txt"',
      'sudo test -f "$POKER_DIR/data/backups/checksums-$STAMP.txt"',
    ],
    [
      'sudo test -f "$POKER_DIR/data/backups/checksums-$STAMP.txt"',
      'sudo sh -c \'cd "$1" && sha256sum --check "$2"\' sh "$POKER_DIR/data/backups" "checksums-$STAMP.txt"',
    ],
    [
      'sudo sh -c \'cd "$1" && sha256sum --check "$2"\' sh "$POKER_DIR/data/backups" "checksums-$STAMP.txt"',
      "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
    ],
  ];
  for (const [before, after] of orderedCommandPairs) {
    if (indexOfCommand(before) >= indexOfCommand(after)) {
      throw new Error(
        `Extreme Space command order is invalid: ${before} must precede ${after}`,
      );
    }
  }

  const firstConfigurationCommand =
    "docker compose --env-file .env.production -f docker-compose.registry.yml config --quiet";
  const backupChecksumCommand =
    'sudo sh -c \'cd "$1" && sha256sum --check "$2"\' sh "$POKER_DIR/data/backups" "checksums-$STAMP.txt"';
  const preBackupStart = indexOfCommand(firstConfigurationCommand);
  const preBackupEnd = indexOfCommand(backupChecksumCommand);
  const allowedPreBackupComposeCommands = new Set([
    firstConfigurationCommand,
    "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/production-backup-target.mjs",
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs",
    "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app",
  ]);
  if (preBackupStart < 0 || preBackupEnd <= preBackupStart) {
    throw new Error("pre-backup executable block is incomplete");
  }
  for (const command of shellCommands.slice(preBackupStart, preBackupEnd + 1)) {
    const normalized = command.trim();
    if (
      /\bdocker\b/i.test(normalized) &&
      !allowedPreBackupComposeCommands.has(normalized)
    ) {
      throw new Error("migration-capable command before backup");
    }
  }

  for (const match of content.matchAll(
    /\b(?:[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)|DATABASE_URL)\s*=\s*([^\s`#]+)/g,
  )) {
    const value = match[1]!.trim().replace(/^['"]|['"]$/g, "");
    if (
      !/^(?:CHANGE_ME(?:_[A-Z0-9_]+)?|replace(?:_[A-Z0-9_]+)?|<password>)$/i.test(
        value,
      )
    ) {
      throw new Error(
        "runbook contains a non-placeholder sensitive assignment",
      );
    }
  }
  for (const match of content.matchAll(/mysql:\/\/[^:\s]+:([^@\s]+)@/gi)) {
    if (
      !/^(?:CHANGE_ME|replace(?:_[A-Z0-9_]+)?|<password>)$/i.test(match[1]!)
    ) {
      throw new Error(
        "runbook contains a non-placeholder database URL credential",
      );
    }
  }

  for (const command of shellCommands) {
    if (/^\s*#/.test(command)) continue;
    if (/\bdocker(?:\s+compose)?\b[^\r\n]*\blatest\b/i.test(command)) {
      throw new Error("runbook contains a mutable latest Docker command");
    }
    if (
      /\bdocker\s+pull\s+docker\.io\/tianyi920\/poker-scorekeeper\s*$/i.test(
        command,
      )
    ) {
      throw new Error("runbook contains an untagged public image pull");
    }
  }
  if (
    /^\s*(?:export\s+)?POKER_IMAGE_VERSION\s*=\s*['"]?latest['"]?\s*(?:#.*)?$/gim.test(
      content,
    )
  ) {
    throw new Error("runbook contains a mutable latest image version");
  }

  const directHttpSection = content.slice(
    content.indexOf("## 4. HTTP 和 IPv6 直连"),
    content.indexOf("## 5. 升级操作卡"),
  );
  for (const requirement of [
    "http://pk.tianyi.wiki",
    "AAAA",
    "容器公网 IPv6",
    "TCP 80",
    "WebSocket",
    "HTTP 明文",
    "不要公开 MariaDB `3306`",
  ]) {
    if (!directHttpSection.includes(requirement))
      throw new Error("direct HTTP IPv6 instructions are incomplete");
  }

  if (
    content.indexOf("### 3.1 立即创建并验证首次备份") >
    content.indexOf("## 5. 升级操作卡")
  ) {
    throw new Error("fresh backup verification does not precede upgrade");
  }

  const firstBackupIndex = content.indexOf("### 3.1 立即创建并验证首次备份");
  const firstPullIndex = content.indexOf(
    "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
  );
  const firstUpIndex = content.indexOf(
    "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
  );
  if (
    firstPullIndex > firstBackupIndex ||
    firstBackupIndex > firstUpIndex ||
    firstBackupIndex > content.indexOf("## 4. HTTP 和 IPv6 直连")
  ) {
    throw new Error(
      "first backup verification is not before the first migration-capable startup",
    );
  }
  const upgradeSection = content.slice(
    content.indexOf("## 5. 升级操作卡"),
    content.indexOf("## 6. 回滚操作卡"),
  );
  if (
    !upgradeSection.includes("第 3.1 节的备份验证块") ||
    !upgradeSection.includes("POKER_IMAGE_VERSION=1.0.6")
  ) {
    throw new Error(
      "upgrade instructions do not require a fresh verified backup and fixed version",
    );
  }
  if (
    upgradeSection.indexOf("POKER_IMAGE_VERSION=1.0.6") >
      upgradeSection.indexOf(
        "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
      ) ||
    upgradeSection.indexOf(
      "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
    ) >
      upgradeSection.indexOf(
        "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
      )
  ) {
    throw new Error("upgrade command order is invalid");
  }
  const rollbackSection = content.slice(content.indexOf("## 6. 回滚操作卡"));
  for (const rollbackCommand of [
    "POKER_IMAGE_VERSION=1.0.2 # previous fixed version",
    "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
    "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
  ]) {
    if (!rollbackSection.includes(rollbackCommand)) {
      throw new Error(
        "rollback instructions do not use a previous fixed version",
      );
    }
  }
  if (
    rollbackSection.indexOf(
      "POKER_IMAGE_VERSION=1.0.2 # previous fixed version",
    ) >
      rollbackSection.indexOf(
        "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
      ) ||
    rollbackSection.indexOf(
      "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
    ) >
      rollbackSection.indexOf(
        "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
      )
  ) {
    throw new Error("rollback command order is invalid");
  }
}

describe("production deployment artifacts", () => {
  it("assembles all runtime application files atomically for NAS container runtimes", async () => {
    // Break caught: some NAS runtimes silently omit late image layers, leaving the entrypoint present but its preflight helper absent.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const bundle = dockerfile.slice(
      dockerfile.indexOf("FROM production-dependencies AS runtime-bundle"),
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );

    expect(bundle).toMatch(
      /^FROM production-dependencies AS runtime-bundle$/m,
    );
    expect(bundle).toContain(
      "COPY --chmod=0555 scripts/docker/entrypoint.sh scripts/docker/healthcheck.mjs scripts/docker/healthcheck-url.mjs /app/scripts/docker/",
    );
    expect(bundle).toContain(
      "COPY --chmod=0555 scripts/database/production-preflight.mjs scripts/database/create-database.mjs scripts/database/production-backup-target.mjs scripts/database/assert-production-avatar-files.mjs scripts/database/production-migration-evidence.mjs /app/scripts/database/",
    );
    expect(bundle).toContain(
      "COPY --chmod=0555 scripts/backup/backup.sh scripts/backup/restore.sh scripts/backup/restore-input-guard.mjs /app/scripts/backup/",
    );
    expect(bundle.match(/^COPY --chmod=\S+ scripts\//gm)).toHaveLength(3);
    expect(bundle).not.toMatch(/^COPY --chmod=0444 scripts\//gm);
    for (const requiredPath of [
      "/app/apps/api/dist",
      "/app/apps/web/dist",
      "/app/apps/api/prisma",
      "/app/packages/contracts/dist",
      "/app/packages/settlement/dist",
      "/app/prisma-schema-engine",
      "/app/deployment-id",
    ]) {
      expect(bundle, requiredPath).toContain(requiredPath);
    }

    expect(runtime.match(/^COPY .*$/gm) ?? []).toEqual([]);
    expect(runtime).not.toMatch(/^COPY --from=(?:build|production-dependencies)\b/m);
    expect(runtime).toContain(
      "RUN --mount=type=bind,from=runtime-bundle,source=/app,target=/mnt/runtime-bundle \\",
    );
    expect(runtime).not.toContain("target=/mnt/runtime-bundle,readonly");
    expect(runtime).not.toMatch(/target=\/mnt\/runtime-bundle,(?:rw|readwrite)/);
    expect(runtime).toContain("cp -a /mnt/runtime-bundle/. /app/");
  });

  it("builds one non-root Node 24 runtime containing API, web, migrations, and production dependencies", async () => {
    // Break caught: the image builds only one half of the monorepo or needs dev dependencies at runtime.
    const dockerfile = await readRepositoryFile("Dockerfile");

    expect(
      dockerfile.match(/^FROM node:24-bookworm-slim AS \w+/gm)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
    expect(dockerfile).toMatch(/pnpm (?:-r )?build/);
    expect(dockerfile).toMatch(/pnpm install --prod --frozen-lockfile/);
    expect(dockerfile).toMatch(/apps\/web\/dist/);
    expect(dockerfile).toMatch(/apps\/api\/prisma/);
    expect(dockerfile).toMatch(/apps\/api\/dist/);
    expect(dockerfile.match(/^ARG DEPLOYMENT_ID$/gm)).toHaveLength(2);
    expect(dockerfile).toContain(
      'node scripts/build/create-deployment-id.mjs "$DEPLOYMENT_ID"',
    );
    expect(dockerfile).toContain(
      "LABEL org.opencontainers.image.revision=$DEPLOYMENT_ID",
    );
    expect(dockerfile).toContain(
      "scripts/database/assert-production-avatar-files.mjs scripts/database/production-migration-evidence.mjs /app/scripts/database/",
    );
    expect(dockerfile).toContain("/app/deployment-id /app/deployment-id");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^\s*PORT=80 \\/m);
    expect(dockerfile).toMatch(/^EXPOSE 80$/m);
    expect(dockerfile).not.toMatch(/^EXPOSE 3000$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "-g", "--"');
    expect(dockerfile).not.toMatch(/FROM .*:latest/);
  });

  it("detects OpenSSL before installing or generating Prisma artifacts", async () => {
    // Break caught: Prisma silently selects an OpenSSL 1.1 engine in a Bookworm/OpenSSL 3 image.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const workspace = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS workspace"),
      dockerfile.indexOf("FROM workspace AS build"),
    );
    const productionDependencies = dockerfile.slice(
      dockerfile.indexOf(
        "FROM node:24-bookworm-slim AS production-dependencies",
      ),
      dockerfile.indexOf("FROM production-dependencies AS runtime-bundle"),
    );

    for (const stage of [workspace, productionDependencies]) {
      expect(stage).toMatch(/apt-get install[^\n]*\bopenssl\b/);
      expect(stage.indexOf("apt-get install")).toBeLessThan(
        stage.indexOf("pnpm install"),
      );
    }
  });

  it("prepares every writable data mount for the non-root runtime user", async () => {
    // Break caught: an empty restore volume is mounted over a missing image path and becomes root-owned.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );
    const dataPreparation = runtime.slice(
      runtime.indexOf("RUN --mount=type=bind,from=runtime-bundle"),
      runtime.indexOf("USER node"),
    );

    const mkdirIndex = dataPreparation.indexOf(
      "mkdir -p /data/avatars /data/backups /data/restore",
    );
    const chownIndex = dataPreparation.indexOf("chown -R node:node /data");
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(chownIndex).toBeGreaterThan(mkdirIndex);
    expect(runtime.indexOf("chown -R node:node /data")).toBeLessThan(
      runtime.indexOf("USER node"),
    );
  });

  it("declares editable secret-free NAS environment defaults in the runtime image", async () => {
    // Break caught: a NAS direct-create wizard omits required deployment fields and forces operators to add every key manually.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );
    for (const assignment of [
      "PUBLIC_ORIGIN=http://pk.tianyi.wiki",
      'WS_ALLOWED_ORIGINS=""',
      "DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper",
      "SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
      "CSRF_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
      "BOOTSTRAP_ADMIN_USERNAME=rootadmin",
      "BOOTSTRAP_ADMIN_NICKNAME=CHANGE_ME_ADMIN_NICKNAME",
      "BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_UNIQUE_STRONG_PASSWORD",
      "READINESS_TIMEOUT_MS=2000",
      "MYSQL_HOST=192.168.10.248",
      "MYSQL_PORT=3306",
      "MYSQL_USER=poker_backup_user",
      "MYSQL_PASSWORD=CHANGE_ME",
      "MYSQL_DATABASE=poker_scorekeeper",
      "BACKUP_DIR=/data/backups",
    ]) {
      expect(runtime, assignment).toContain(assignment);
    }
  });

  it("declares exactly the three operator-managed persistent data volumes", async () => {
    // Break caught: a NAS wizard cannot pre-populate the host-folder rows or silently creates an unmanaged extra volume.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );

    expect(runtime.match(/^VOLUME .*$/gm)).toEqual([
      'VOLUME ["/data/avatars", "/data/backups", "/data/restore"]',
    ]);
    expect(runtime.indexOf("chown -R node:node /data")).toBeLessThan(
      runtime.indexOf('VOLUME ["/data/avatars"'),
    );
  });

  it("bundles a fixed Prisma schema engine before switching to the non-root runtime user", async () => {
    // Break caught: migrate deploy tries to download into root-owned node_modules and the app exits before health checks pass.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const build = dockerfile.slice(
      dockerfile.indexOf("FROM workspace AS build"),
      dockerfile.indexOf(
        "FROM node:24-bookworm-slim AS production-dependencies",
      ),
    );
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );
    const bundle = dockerfile.slice(
      dockerfile.indexOf("FROM production-dependencies AS runtime-bundle"),
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );

    expect(build).toContain(
      'install -m 0555 "$engine_path" /app/prisma-schema-engine',
    );
    expect(runtime).toContain(
      "PRISMA_SCHEMA_ENGINE_BINARY=/app/prisma-schema-engine",
    );
    expect(bundle).toContain(
      "COPY --from=build --chmod=0555 /app/prisma-schema-engine /app/prisma-schema-engine",
    );
    expect(
      runtime.indexOf("cp -a /mnt/runtime-bundle/. /app/"),
    ).toBeLessThan(runtime.indexOf("USER node"));
    const finalUserPreflight = runtime.slice(
      runtime.indexOf("USER node"),
      runtime.indexOf("EXPOSE"),
    );
    expect(finalUserPreflight).toContain("RUN set -eux; \\");
    expect(finalUserPreflight).toContain("test -x /app/prisma-schema-engine");
    expect(finalUserPreflight).toContain(
      "test -x /app/apps/api/node_modules/.bin/prisma",
    );
  });

  it("passes the packaged Prisma config to every runtime migration command", async () => {
    // Break caught: runtime commands execute from /app, so Prisma cannot discover apps/api/prisma.config.ts implicitly.
    const migration =
      "/app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts";
    const [entrypoint, testCompose, candidate, productionChecklist, synology] =
      await Promise.all([
        readRepositoryFile("scripts/docker/entrypoint.sh"),
        readRepositoryFile("docker-compose.test.yml"),
        readRepositoryFile("scripts/ci/verify-candidate-image.sh"),
        readRepositoryFile("docs/deployment/production-checklist.md"),
        readRepositoryFile("docs/deployment/synology.md"),
      ]);

    expect(entrypoint).toContain(`${migration} &`);
    expect(testCompose).toContain(`${migration} && exec node`);
    expect(candidate).toContain(`app ${migration}`);
    expect(productionChecklist).toContain(`app ${migration}`);
    expect(synology).toContain(`app ${migration}`);
  });

  it("starts by deploying migrations and then replacing the shell with the API process", async () => {
    // Break caught: migrations are skipped or PID 1 does not receive termination signals.
    const entrypoint = await readRepositoryFile("scripts/docker/entrypoint.sh");

    expect(entrypoint).toContain("set -euo pipefail");
    expect(entrypoint).not.toContain("PRODUCTION_TARGET_REQUIRED");
    expect(entrypoint).toMatch(
      /^\s*node scripts\/database\/production-preflight\.mjs >\/dev\/null$/m,
    );
    expect(entrypoint.indexOf("production-preflight.mjs")).toBeLessThan(
      entrypoint.indexOf("prisma migrate deploy"),
    );
    expect(entrypoint).toMatch(/prisma migrate deploy/);
    expect(entrypoint).toMatch(/exec node apps\/api\/dist\/main\.js/);
  });

  it("keeps the runtime independent from Corepack while preserving direct Prisma migrations", async () => {
    // Break caught: the production runtime requires pnpm/Corepack instead of the installed Prisma executable.
    const dockerfile = await readRepositoryFile("Dockerfile");
    const entrypoint = await readRepositoryFile("scripts/docker/entrypoint.sh");
    const compose = parse(
      await readRepositoryFile("docker-compose.test.yml"),
    ) as {
      services: { app: ComposeService };
    };
    const runtime = dockerfile.slice(
      dockerfile.indexOf("FROM node:24-bookworm-slim AS runtime"),
    );

    expect(runtime).not.toMatch(/corepack|PNPM_HOME|pnpm\s/);
    expect(runtime).toContain("test -x /app/apps/api/node_modules/.bin/prisma");
    expect(runtime).not.toContain("COPY scripts ./scripts");
    expect(runtime).not.toMatch(
      /\.test\.ts|run-with-test-env|seed-release-drill|assert-restored/,
    );
    // Break caught: root verifies only mode bits while the final node user cannot execute Prisma.
    expect(
      runtime.slice(runtime.indexOf("USER node"), runtime.indexOf("EXPOSE")),
    ).toContain("test -x /app/apps/api/node_modules/.bin/prisma");
    expect(entrypoint).toContain(
      "/app/apps/api/node_modules/.bin/prisma migrate deploy",
    );
    expect(entrypoint).not.toMatch(/\bpnpm\b|\bcorepack\b/);
    expect(compose.services.app.command).toContain(
      "/app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts && exec node apps/api/dist/main.js",
    );
  });

  it("makes every container release helper available without shipping test helpers", async () => {
    // Break caught: the hosted drill reaches seed or restore assertions that are absent from the runtime image.
    const release = await readRepositoryFile("scripts/verify-release.ps1");
    const dockerfile = await readRepositoryFile("Dockerfile");
    const testCompose = await readRepositoryFile("docker-compose.test.yml");
    const productionComposes = await Promise.all([
      readRepositoryFile("docker-compose.yml"),
      readRepositoryFile("docker-compose.registry.yml"),
    ]);
    const trackedFiles = new Set(
      execFileSync("git", ["ls-files", "--", ...testOnlyReleaseHelpers], {
        cwd: repositoryRoot,
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    );
    const artifacts = {
      release,
      dockerfile,
      testCompose,
      productionComposes,
      trackedFiles,
    };

    expect(() => validateReleaseHelperAvailability(artifacts)).not.toThrow();

    const seedMount =
      "./scripts/database/seed-release-drill.mjs:/app/scripts/database/seed-release-drill.mjs:ro";
    const mutations = [
      testCompose.replace(seedMount, ""),
      testCompose.replace(seedMount, seedMount.replace(":ro", ":rw")),
      testCompose.replace(
        seedMount,
        seedMount.replace(
          "/app/scripts/database/seed-release-drill.mjs",
          "/app/scripts/database/wrong-target.mjs",
        ),
      ),
    ];
    for (const mutatedCompose of mutations) {
      expect(() =>
        validateReleaseHelperAvailability({
          ...artifacts,
          testCompose: mutatedCompose,
        }),
      ).toThrow();
    }
  });

  it("publishes the app directly on HTTP port 80 with non-root low-port binding", async () => {
    // Break caught: the public IPv6 reaches a closed/wrong port or the non-root process cannot bind port 80.
    const compose = parse(await readRepositoryFile("docker-compose.yml")) as {
      services: { app: ComposeService };
    };
    expect(Object.keys(compose.services)).toEqual(["app"]);
    expect(compose.services.app.ports).toEqual(["80:80"]);
    expect(compose.services.app.environment?.PORT).toBe("80");
    expect(compose.services.app.sysctls).toEqual({
      "net.ipv4.ip_unprivileged_port_start": "0",
    });
    expect(compose.services.app.env_file).toEqual([".env.production"]);
    expect(compose.services.app.build?.args?.DEPLOYMENT_ID).toBe(
      "${DEPLOYMENT_ID:?DEPLOYMENT_ID is required}",
    );
    expect(compose.services.app.environment).not.toHaveProperty(
      "PRODUCTION_TARGET_REQUIRED",
    );
    expect(compose.services.app.volumes).toEqual(
      expect.arrayContaining([
        "./data/avatars:/data/avatars",
        "./data/backups:/data/backups",
        "./data/restore:/data/restore",
      ]),
    );
    expect(compose.services.app.healthcheck).toMatchObject({
      test: ["CMD", "node", "scripts/docker/healthcheck.mjs"],
    });
    expect(compose.services.app.security_opt).toContain(
      "no-new-privileges:true",
    );
    expect(compose.services.app.cap_drop).toContain("ALL");
  });

  it("keeps the optional smoke database isolated and unmistakably test-only", async () => {
    // Break caught: local container verification can reach the user-owned remote or production schema.
    const compose = parse(
      await readRepositoryFile("docker-compose.test.yml"),
    ) as {
      services: { app: ComposeService; mysql: ComposeService };
      networks: Record<string, { internal?: boolean } | null>;
    };
    expect(Object.keys(compose.services).sort()).toEqual(["app", "mysql"]);
    expect(compose.services.mysql.ports).toBeUndefined();
    expect(compose.services.app.ports).toEqual(["127.0.0.1:3000:3000"]);
    const databaseUrl = compose.services.app.environment?.DATABASE_URL;
    expect(databaseUrl).toBeDefined();
    expect(databaseUrl).toContain("@mysql:3306/poker_scorekeeper_test");
    expect(databaseUrl).not.toMatch(
      /tianyi\.wiki|192\.168\.10\.248|poker_scorekeeper(?:\?|$)/,
    );
    expect(compose.services.mysql.environment?.MYSQL_DATABASE).toBe(
      "poker_scorekeeper_test",
    );
    expect(compose.services.mysql.networks).toEqual(["isolated_test"]);
    expect(compose.services.app.networks).toEqual([
      "isolated_test",
      "host_test",
    ]);
    expect(compose.networks.isolated_test?.internal).toBe(true);
    expect(compose.networks.host_test?.internal).not.toBe(true);
    expect(compose.services.app.build?.args?.DEPLOYMENT_ID).toBe(
      "${DEPLOYMENT_ID:-test-build-20260819}",
    );
    expect(compose.services.app.entrypoint).toEqual([]);
    expect(compose.services.app.command).toEqual([
      "/usr/bin/tini",
      "-g",
      "--",
      "sh",
      "-c",
      "/app/apps/api/node_modules/.bin/prisma migrate deploy --config /app/apps/api/prisma.config.ts && exec node apps/api/dist/main.js",
    ]);
  });

  it("prevents source secrets and mutable local data from entering the build context", async () => {
    const ignore = await readRepositoryFile(".dockerignore");
    for (const pattern of [
      ".env",
      ".env.*",
      "node_modules",
      ".worktrees",
      "data",
      "backups",
    ]) {
      expect(ignore.split(/\r?\n/)).toContain(pattern);
    }
    expect(ignore.split(/\r?\n/)).toContain("!.env.example");
    expect(() => validateGeneratedOutputExclusions(ignore)).not.toThrow();
    expect(() =>
      validateGeneratedOutputExclusions(ignore.replace("test-results/", "")),
    ).toThrow(/missing generated-output exclusion/);
    expect(() =>
      validateGeneratedOutputExclusions(
        `${ignore}\n!playwright-report/index.html\n`,
      ),
    ).toThrow(/re-included/);
  });

  it("provides a fixed-version registry compose bundle without a database service", async () => {
    const compose = parse(
      await readRepositoryFile("docker-compose.registry.yml"),
    ) as {
      services: { app: ComposeService };
    };

    expect(Object.keys(compose.services)).toEqual(["app"]);
    expect(compose.services.app.build).toBeUndefined();
    expect(compose.services.app.image).toBe(
      "docker.io/tianyi920/poker-scorekeeper:${POKER_IMAGE_VERSION:?POKER_IMAGE_VERSION is required}",
    );
    expect(compose.services.app.ports).toEqual(["80:80"]);
    expect(compose.services.app.environment?.PORT).toBe("80");
    expect(compose.services.app.sysctls).toEqual({
      "net.ipv4.ip_unprivileged_port_start": "0",
    });
    expect(compose.services.app.env_file).toEqual([".env.production"]);
    expect(compose.services.app.volumes).toEqual(
      expect.arrayContaining([
        "./data/avatars:/data/avatars",
        "./data/backups:/data/backups",
        "./data/restore:/data/restore",
      ]),
    );
    expect(compose.services.app.read_only).toBe(true);
    expect(compose.services.app.cap_drop).toContain("ALL");
    expect(compose.services.app.restart).toBe("unless-stopped");
    expect(compose.services.app.tmpfs).toContain("/tmp:size=64m,mode=1777");
    expect(compose.services.app.security_opt).toContain(
      "no-new-privileges:true",
    );
    expect(compose.services.app.healthcheck).toMatchObject({
      test: ["CMD", "node", "scripts/docker/healthcheck.mjs"],
    });
  });

  it("provides a secret-free Extreme Space environment template", async () => {
    const environment = await readRepositoryFile(".env.extremespace.example");
    const values = validateExtremeSpaceEnvironmentTemplate(environment);

    expect(environment).toContain("POKER_IMAGE_VERSION=1.0.6");
    expect(environment).toContain("PORT=80");
    expect(environment).toContain("PUBLIC_ORIGIN=http://pk.tianyi.wiki");
    expect(environment).toContain(
      "DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper",
    );
    expect(environment).toContain("MYSQL_HOST=192.168.10.248");
    expect(environment).toContain("MYSQL_PORT=3306");
    expect(environment).toContain("MYSQL_DATABASE=poker_scorekeeper");
    expect(environment).toContain(
      "SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
    );
    expect(environment).toContain(
      "CSRF_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
    );
    expect(environment).toContain(
      "BOOTSTRAP_ADMIN_PASSWORD=CHANGE_ME_UNIQUE_STRONG_PASSWORD",
    );
    expect(environment).toContain("MYSQL_PASSWORD=CHANGE_ME");
    expect(values).toMatchObject({
      DATABASE_URL:
        "mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper",
      SESSION_SECRET: "CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
      CSRF_SECRET: "CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
      BOOTSTRAP_ADMIN_PASSWORD: "CHANGE_ME_UNIQUE_STRONG_PASSWORD",
      MYSQL_PASSWORD: "CHANGE_ME",
    });
  });

  it("documents source-free Extreme Space deployment with fixed image versions", async () => {
    // Break caught: a NAS operator needs the private source repository or is told to deploy a mutable image.
    const runbook = await readRepositoryFile("docs/deployment/extremespace.md");

    expect(() => validateExtremeSpaceRunbook(runbook)).not.toThrow();

    for (const required of [
      "github.com/tianyi0920/poker-scorekeeper",
      "docker.io/tianyi920/poker-scorekeeper:1.0.6",
      "docker-compose.registry.yml",
      ".env.extremespace.example",
      "cp .env.extremespace.example .env.production",
      "chmod 600 .env.production",
      "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
      "docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
      "/api/health/live",
      "/api/health/ready",
      "/api/health/deployment",
      "单独创建容器",
      "环境变量会自动列出",
      "三个数据卷会自动列出",
      "匿名卷",
      "点击“应用”前，必须先完成第 3.1 节",
      "只选择一种正式启动方式",
      "不要再执行 Compose 的 `up -d`",
      "升级单独创建的容器时",
      "回滚单独创建的容器时",
    ]) {
      expect(runbook).toContain(required);
    }

    expect(runbook).toContain("POKER_IMAGE_VERSION=1.0.2");
    expect(runbook).toMatch(/POKER_IMAGE_VERSION=.*previous fixed version/i);
    expect(runbook).toContain("forward-only");
    expect(runbook).toContain("does not roll back the schema");
    expect(runbook).toContain("不需要完整源码树");
    expect(runbook).toContain(
      "EXISTING_AVATAR_DIR=/path/to/current-avatar-store-or-REUSE-or-NONE",
    );
    expect(runbook).toContain(
      "scripts/database/assert-production-avatar-files.mjs",
    );
    expect(runbook).toContain(
      'sudo cp -a "$EXISTING_AVATAR_DIR"/. "$POKER_DIR/data/avatars"/',
    );
    expect(runbook).toContain(
      'sudo diff -qr "$EXISTING_AVATAR_DIR" "$POKER_DIR/data/avatars"',
    );
    expect(runbook).not.toMatch(
      /mysql:\/\/[^:\s]+:(?!CHANGE_ME|<password>)[^@\s]+@/,
    );
    const productionCommands = runbook.match(/^docker compose .*$/gm) ?? [];
    const imageVersionExamples =
      runbook.match(/^POKER_IMAGE_VERSION=.*$/gm) ?? [];
    expect(productionCommands.join("\n")).not.toMatch(/\blatest\b/i);
    expect(imageVersionExamples.join("\n")).not.toMatch(/\blatest\b/i);

    const synologyRunbook = await readRepositoryFile(
      "docs/deployment/synology.md",
    );
    expect(synologyRunbook).toContain(
      "[Docker Hub 固定版本部署操作卡](./extremespace.md)",
    );
    expect(synologyRunbook).toContain("源码构建、完整验证、备份和恢复流程");
  });

  it("rejects unsafe or incomplete Extreme Space deployment instructions", async () => {
    const runbook = await readRepositoryFile("docs/deployment/extremespace.md");

    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          'chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
          "",
        ),
      ),
    ).toThrow(/runbook requirement/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          'sudo test -f "$POKER_DIR/data/backups/checksums-$STAMP.txt"',
          "",
        ),
      ),
    ).toThrow(/runbook requirement/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          /### 3\.1 立即创建并验证首次备份[\s\S]*?## 4\. HTTP 和 IPv6 直连/,
          "## 4. HTTP 和 IPv6 直连",
        ),
      ),
    ).toThrow(/runbook requirement/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\nSESSION_SECRET=real-secret-value`,
      ),
    ).toThrow(/sensitive assignment/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n# SESSION_SECRET=real-secret-value`,
      ),
    ).toThrow(/sensitive assignment/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n示例 SESSION_SECRET=real-secret-value`,
      ),
    ).toThrow(/sensitive assignment/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n# SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES`,
      ),
    ).not.toThrow();
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n\`\`\`sh\n  docker pull docker.io/tianyi920/poker-scorekeeper:latest\n\`\`\``,
      ),
    ).toThrow(/mutable latest Docker command/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n\`\`\`sh\n\tdocker compose -f docker-compose.registry.yml up -d # latest\n\`\`\``,
      ),
    ).toThrow(/mutable latest Docker command/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n\`\`\`sh\n  sudo docker pull docker.io/tianyi920/poker-scorekeeper:latest\n\`\`\``,
      ),
    ).toThrow(/mutable latest Docker command/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n\`\`\`sh\n docker pull docker.io/tianyi920/poker-scorekeeper\n\`\`\``,
      ),
    ).toThrow(/untagged public image pull/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          "POKER_IMAGE_VERSION=1.0.6",
          'POKER_IMAGE_VERSION="latest"',
        ),
      ),
    ).toThrow(/mutable latest image version/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          "POKER_IMAGE_VERSION=1.0.6",
          "export POKER_IMAGE_VERSION='latest'",
        ),
      ),
    ).toThrow(/mutable latest image version/);
    expect(() =>
      validateExtremeSpaceRunbook(
        `${runbook}\n不要运行 \`docker pull docker.io/tianyi920/poker-scorekeeper:latest\`。\n\`\`\`sh\n# do not run docker pull docker.io/tianyi920/poker-scorekeeper:latest\n\`\`\``,
      ),
    ).not.toThrow();
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          'sudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore\nsudo chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
          'sudo chmod 750 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore\nsudo chown -R 1000:1000 "$POKER_DIR"/data/avatars "$POKER_DIR"/data/backups "$POKER_DIR"/data/restore',
        ),
      ),
    ).toThrow(/command order/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace("在管理界面复核三项权限已生效", ""),
      ),
    ).toThrow(/runbook requirement/);
    const aclGrantRemoved = runbook.replace(
      '请在管理界面为 UID/GID `1000:1000` 在 `"$POKER_DIR"/data/avatars`、`"$POKER_DIR"/data/backups`、`"$POKER_DIR"/data/restore` 授予读、写和进入权限，并',
      "",
    );
    expect(() => validateExtremeSpaceRunbook(aclGrantRemoved)).toThrow(
      /ACL fallback/,
    );
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs\ndocker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app",
          "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint /app/scripts/backup/backup.sh app\ndocker compose --env-file .env.production -f docker-compose.registry.yml run --rm -T --no-deps --entrypoint node app scripts/database/assert-production-avatar-files.mjs",
        ),
      ),
    ).toThrow(/command order/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          "run --rm -T --no-deps --entrypoint node app",
          "run --rm -T --no-deps app",
        ),
      ),
    ).toThrow(/runbook requirement/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
          "docker compose --env-file .env.production -f docker-compose.registry.yml pull\ndocker compose --env-file .env.production -f docker-compose.registry.yml up -d",
        ),
      ),
    ).toThrow(/first migration-capable startup|command order/);
    for (const unsafeStartup of [
      "docker compose --env-file .env.production -f docker-compose.registry.yml start app",
      "docker compose --env-file .env.production -f docker-compose.registry.yml restart app",
      "docker compose --env-file .env.production -f docker-compose.registry.yml run --rm app",
      "sudo docker compose --env-file .env.production -f docker-compose.registry.yml start app",
      "sudo -n docker compose --env-file .env.production -f docker-compose.registry.yml restart app",
      "env COMPOSE_PROJECT_NAME=poker docker compose --env-file .env.production -f docker-compose.registry.yml run --rm app",
      "/usr/bin/docker compose --env-file .env.production -f docker-compose.registry.yml up -d",
      "docker --context default compose --env-file .env.production -f docker-compose.registry.yml start app",
      "docker-compose --env-file .env.production -f docker-compose.registry.yml start app",
    ]) {
      expect(() =>
        validateExtremeSpaceRunbook(
          runbook.replace(
            "docker compose --env-file .env.production -f docker-compose.registry.yml pull",
            `docker compose --env-file .env.production -f docker-compose.registry.yml pull\n${unsafeStartup}`,
          ),
        ),
      ).toThrow(/migration-capable command before backup/);
    }
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          /(## 5\. 升级操作卡[\s\S]*?)POKER_IMAGE_VERSION=1\.0\.6/,
          "$1docker compose --env-file .env.production -f docker-compose.registry.yml pull\nPOKER_IMAGE_VERSION=1.0.6",
        ),
      ),
    ).toThrow(/upgrade command order/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace("`pk.tianyi.wiki` 的 AAAA 必须等于容器公网 IPv6", ""),
      ),
    ).toThrow(/direct HTTP IPv6 instructions/);
    expect(() =>
      validateExtremeSpaceRunbook(
        runbook.replace(
          /(## 6\. 回滚操作卡[\s\S]*?)docker compose --env-file \.env\.production -f docker-compose\.registry\.yml up -d/,
          "$1",
        ),
      ),
    ).toThrow(/rollback instructions/);
  });

  it("rejects a sensitive placeholder that only starts with the approved prefix", async () => {
    const environment = await readRepositoryFile(".env.extremespace.example");
    const mutated = environment.replace(
      "SESSION_SECRET=CHANGE_ME_AT_LEAST_32_RANDOM_BYTES",
      "SESSION_SECRET=CHANGE_ME_real_secret",
    );

    expect(() => validateExtremeSpaceEnvironmentTemplate(mutated)).toThrow();
  });

  it("rejects extra sensitive assignments and credential-bearing comments or URLs", async () => {
    const environment = await readRepositoryFile(".env.extremespace.example");

    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nEXTRA_API_TOKEN=CHANGE_ME`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\n# SESSION_SECRET=leaked-secret`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\n# mysql://poker_user:leaked-secret@192.168.10.248:3306/poker_scorekeeper`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        environment.replace(
          "DATABASE_URL=mysql://poker_user:CHANGE_ME@192.168.10.248:3306/poker_scorekeeper",
          "DATABASE_URL=mysql://poker_user:leaked-secret@192.168.10.248:3306/poker_scorekeeper",
        ),
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nSESSION_SECRET=leaked-secret`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nAPI_KEY=CHANGE_ME`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nPRIVATE_KEY=CHANGE_ME`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nCREDENTIAL=CHANGE_ME`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\n# SESSION_SECRET leaked-secret`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\nEXTRA_SETTING=1`,
      ),
    ).toThrow();
    expect(() =>
      validateExtremeSpaceEnvironmentTemplate(
        `${environment}\n# unrecognized benign deployment note`,
      ),
    ).toThrow();
  });

  it("keeps Linux deployment scripts and Node modules checked out with LF endings on Windows", async () => {
    // Break caught: core.autocrlf converts Docker runtime scripts to CRLF, which breaks Linux shell parsing.
    const attributes = await readRepositoryFile(".gitattributes");
    for (const rule of [
      "*.sh text eol=lf",
      "*.mjs text eol=lf",
      "*.mts text eol=lf",
    ]) {
      expect(attributes.split(/\r?\n/)).toContain(rule);
    }

    const runtimeFiles = [
      "scripts/docker/entrypoint.sh",
      "scripts/backup/backup.sh",
      "scripts/backup/restore.sh",
      "scripts/docker/healthcheck.mjs",
      "scripts/backup/restore-input-guard.mjs",
      "scripts/backup/restore-input-guard.d.mts",
    ];
    for (const path of runtimeFiles) {
      expect(await readFile(resolve(repositoryRoot, path))).not.toContain(0x0d);
    }
  });

  it("documents Synology production and remote-test database hosts using placeholders only", async () => {
    // Break caught: a real database credential is copied into an image, compose file, or runbook.
    const paths = [
      ".env.example",
      "docker-compose.yml",
      "docker-compose.test.yml",
      "docs/deployment/synology.md",
      "docs/deployment/backup-restore.md",
    ];
    const artifacts = (await Promise.all(paths.map(readRepositoryFile))).join(
      "\n",
    );
    expect(artifacts).toContain("192.168.10.248:3306");
    expect(artifacts).toContain("tianyi.wiki:8306");
    expect(artifacts).toMatch(/replace_me|<password>|CHANGE_ME/);
    expect(artifacts).not.toMatch(
      /mysql:\/\/[^:\s]+:(?!replace_me|<password>|CHANGE_ME)[^@\s]+@(?:tianyi\.wiki|192\.168\.10\.248)/,
    );
  });

  it("uses the installed Prisma binary in every active deployment guide", async () => {
    const deploymentGuideNames = (
      await readdir(resolve(repositoryRoot, "docs/deployment"))
    ).filter((name) => name.endsWith(".md"));
    const guides = await Promise.all(
      deploymentGuideNames.map((name) =>
        readRepositoryFile(`docs/deployment/${name}`),
      ),
    );

    expect(() => validateActiveGuideMigrationCommands(guides)).not.toThrow();
    expect(() =>
      validateActiveGuideMigrationCommands(
        guides.map((guide) =>
          guide.replace(
            "/app/apps/api/node_modules/.bin/prisma migrate deploy",
            "pnpm --filter @poker/api prisma migrate deploy",
          ),
        ),
      ),
    ).toThrow(/runtime package manager/);
  });

  it("keeps release verification fail-closed across local, browser, image, restart, backup, and restore gates", async () => {
    const release = await readRepositoryFile("scripts/verify-release.ps1");
    const releaseHelpers = await readRepositoryFile(
      "scripts/release/release-helpers.ps1",
    );
    const releaseRuntime = `${release}\n${releaseHelpers}`;
    const rootPackage = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as {
      packageManager: string;
      scripts: Record<string, string>;
    };

    expect(rootPackage.packageManager).toBe("pnpm@10.15.1");
    expect(rootPackage.scripts["verify:release"]).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release.ps1",
    );
    for (const required of [
      "pnpm install --frozen-lockfile",
      "pnpm typecheck",
      "pnpm test",
      "test:integration",
      "playwright test",
      "pnpm build",
      "docker build",
      "docker compose",
      "restart app",
      "backup.sh",
      "restore.sh",
      "assert-restored-data.mjs",
    ])
      expect(release).toContain(required);
    expect(release).toContain("10.15.1");
    expect(release).toContain("poker_scorekeeper_restore_test");
    expect(release).toMatch(
      /run-with-test-env\.mjs[^\r\n]+playwright[^\r\n]+test/,
    );
    expect(release).toMatch(
      /^\[CmdletBinding\(\)\]\r?\nparam\(\[switch\] \$ContainerOnly\)/,
    );
    const localGateStart = release.indexOf("if (-not $ContainerOnly) {");
    const containerDrillStart = release.indexOf("$runId =");
    expect(localGateStart).toBeGreaterThanOrEqual(0);
    expect(containerDrillStart).toBeGreaterThan(localGateStart);
    const localGateBlock = release.slice(localGateStart, containerDrillStart);
    const containerOnlyRuntime =
      release.slice(0, localGateStart) + release.slice(containerDrillStart);
    expect(localGateBlock.match(/run-with-test-env\.mjs/g)).toHaveLength(6);
    expect(containerOnlyRuntime).not.toMatch(/run-with-test-env|\.env\.local/);
    expect(release).toContain("assert-restored-api.mjs");
    expect(releaseRuntime).toContain("/api/health/live");
    expect(releaseRuntime).toContain("/api/health/ready");
    expect(release).toContain("/api/health/deployment");
    expect(release).toContain("scripts/release/assert-deployment-response.mjs");
    expect(
      release.match(
        /^\s*Assert-DeploymentIdentity -BaseUri '[^']+' -ExpectedDeploymentId \$deploymentId$/gm,
      ),
    ).toHaveLength(3);
    expect(release.match(/Wait-ApplicationHealthy/g)).toHaveLength(3);
    expect(
      release.match(
        /^\s*Write-ComposeStartupDiagnostics -Docker \$docker -Compose \$compose$/gm,
      ),
    ).toHaveLength(1);
    expect(release).toContain("'logs', '--no-color', '--tail', '200', 'app'");
    expect(release).toContain("'ps', '-a'");
    expect(release).toContain(
      "@('exec', '-T', 'app', '/app/scripts/backup/backup.sh')",
    );
    expect(release).not.toContain(
      "@('exec', '-T', 'app', 'sh', 'scripts/backup/backup.sh')",
    );
    expect(release).toContain(
      "'--entrypoint', '/app/scripts/backup/restore.sh', 'app'",
    );
    expect(release).not.toContain(
      "'--entrypoint', 'sh', 'app', 'scripts/backup/restore.sh'",
    );
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3000/);
    expect(release).toMatch(/Assert-PortAvailable[^\r\n]+3001/);
    expect(releaseRuntime).toMatch(/--env-file|--env-from-file/);
    expect(releaseRuntime).toMatch(
      /UnixCreateMode[\s\S]+UserRead[\s\S]+UserWrite/,
    );
    expect(releaseRuntime).toContain("SetAccessRuleProtection($true, $false)");
    expect(release).not.toMatch(/["']-e["'][^\r\n]+(?:PASSWORD|DATABASE_URL)/);
    expect(release).not.toMatch(
      /(?:Invoke-External\s+\$docker|&\s+\$docker)[^\r\n]*DATABASE_URL/,
    );
    expect(release).toMatch(
      /finally[\s\S]+Remove-PrivateEnvironmentFile[^\r\n]+restoreEnvironmentContext/,
    );
    expect(release).not.toContain("ON *.*");
    expect(release).not.toMatch(/--skip|SKIP_DOCKER|continue-on-error/i);

    const dockerPreflight = release.indexOf("Assert-DockerCapabilities");
    const longLocalGate = release.indexOf(
      "gate: pnpm install --frozen-lockfile",
    );
    expect(dockerPreflight).toBeGreaterThanOrEqual(0);
    expect(dockerPreflight).toBeLessThan(longLocalGate);
    expect(releaseRuntime).toContain("2.34.0");

    const runbook = await readRepositoryFile("docs/deployment/synology.md");
    expect(runbook).toContain("Docker Compose 2.34.0");
  });

  it("asserts restored completed history and uploaded avatar only in the exact isolated restore schema", async () => {
    const assertion = await readRepositoryFile(
      "scripts/database/assert-restored-data.mjs",
    );
    expect(assertion).toContain("poker_scorekeeper_restore_test");
    expect(assertion).toMatch(/COMPLETED/);
    expect(assertion).toMatch(/settlements/);
    expect(assertion).toMatch(/avatar_kind_snapshot/);
    expect(assertion).toMatch(/RESTORE_AVATAR_ROOT/);
    expect(assertion).not.toMatch(
      /DROP\s+(?:DATABASE|TABLE)|TRUNCATE|DELETE\s+FROM/i,
    );
  });
});
