import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyProductionAvatarFiles } from "./assert-production-avatar-files.mjs";

const productionUrl =
  "mysql://avatar_verifier:never-print-me@192.168.10.248:3306/poker_scorekeeper";

function stats(kind: "directory" | "file" | "symlink") {
  return {
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function fakeConnector(options: { tables?: string[]; values?: unknown[] }) {
  const queries: string[] = [];
  const connectionOptions: Array<Record<string, unknown>> = [];
  let ended = false;
  return {
    queries,
    connectionOptions,
    get ended() {
      return ended;
    },
    connect: async (received: Record<string, unknown>) => {
      connectionOptions.push(received);
      return {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("information_schema.TABLES")) {
            return (options.tables ?? ["users", "game_players"]).map(
              (tableName) => ({ tableName }),
            );
          }
          if (sql.includes("avatar_value")) {
            return (options.values ?? []).map((avatarValue) => ({
              avatarValue,
            }));
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        end: async () => {
          ended = true;
        },
      };
    },
  };
}

describe("read-only production avatar continuity verification", () => {
  it("checks every distinct current and historical upload reference as a direct regular file", async () => {
    // Break caught: a valid database backup is paired with an empty or incomplete avatar archive.
    const first = "playera-123e4567-e89b-42d3-a456-426614174000.webp";
    const second = "playerb-123e4567-e89b-42d3-a456-426614174001.webp";
    const fake = fakeConnector({ values: [first, second] });
    const checkedPaths: string[] = [];

    const report = await verifyProductionAvatarFiles(
      {
        DATABASE_URL: productionUrl,
        AVATAR_ROOT: "/data/avatars",
      },
      {
        connect: fake.connect,
        lstat: async (path) => {
          checkedPaths.push(path);
          return stats(path === "/data/avatars" ? "directory" : "file");
        },
      },
    );

    expect(report).toEqual({ uploadFileCount: 2 });
    expect(checkedPaths).toEqual([
      "/data/avatars",
      `/data/avatars/${first}`,
      `/data/avatars/${second}`,
    ]);
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries.join("\n")).toMatch(/users[\s\S]*game_players/);
    expect(fake.queries.join("\n")).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|REPLACE|LOCK)\b/i,
    );
    expect(fake.connectionOptions).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("never-print-me");
    expect(fake.ended).toBe(true);
  });

  it("allows an empty avatar directory only when the production schema has no upload references", async () => {
    const fake = fakeConnector({ values: [] });

    await expect(
      verifyProductionAvatarFiles(
        {
          DATABASE_URL: productionUrl,
          AVATAR_ROOT: "/data/avatars",
        },
        {
          connect: fake.connect,
          lstat: async (path) =>
            stats(path === "/data/avatars" ? "directory" : "file"),
        },
      ),
    ).resolves.toEqual({ uploadFileCount: 0 });

    expect(fake.queries).toHaveLength(2);
    expect(fake.ended).toBe(true);
  });

  it.each([
    ["no visible required tables", []],
    ["only one visible required table", ["users"]],
  ])(
    "rejects %s instead of treating it as zero upload references",
    async (_case, tables) => {
      // Break caught: an empty or privilege-hidden schema self-fulfills a zero-reference assertion.
      const fake = fakeConnector({ tables });

      await expect(
        verifyProductionAvatarFiles(
          {
            DATABASE_URL: productionUrl,
            AVATAR_ROOT: "/data/avatars",
          },
          {
            connect: fake.connect,
            lstat: async (path) =>
              stats(path === "/data/avatars" ? "directory" : "file"),
          },
        ),
      ).rejects.toThrow("PRODUCTION_AVATAR_SCHEMA_INCOMPLETE");
      expect(fake.queries).toHaveLength(1);
      expect(fake.ended).toBe(true);
    },
  );

  it.each([
    ["unsafe nested reference", "../outside.webp", "file"],
    [
      "missing referenced file",
      "playera-123e4567-e89b-42d3-a456-426614174000.webp",
      "missing",
    ],
    [
      "symlink referenced file",
      "playera-123e4567-e89b-42d3-a456-426614174000.webp",
      "symlink",
    ],
  ])(
    "fails closed for %s without exposing a filename or credential",
    async (_case, avatarValue, fileKind) => {
      const fake = fakeConnector({ values: [avatarValue] });
      const run = verifyProductionAvatarFiles(
        {
          DATABASE_URL: productionUrl,
          AVATAR_ROOT: "/data/avatars",
        },
        {
          connect: fake.connect,
          lstat: async (path) => {
            if (path === "/data/avatars") return stats("directory");
            if (fileKind === "missing")
              throw new Error("uncontrolled missing path");
            return stats(fileKind as "file" | "symlink");
          },
        },
      );

      const error = await run.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /^PRODUCTION_AVATAR_[A-Z0-9_]+$/,
      );
      expect((error as Error).message).not.toContain(avatarValue);
      expect((error as Error).message).not.toContain("never-print-me");
      expect(fake.ended).toBe(true);
    },
  );

  it("rejects any alternate database or avatar mount before reading either dependency", async () => {
    const connect = vi.fn();
    const lstat = vi.fn();

    await expect(
      verifyProductionAvatarFiles(
        {
          DATABASE_URL: productionUrl.replace(
            "poker_scorekeeper",
            "poker_scorekeeper_test",
          ),
          AVATAR_ROOT: "/data/avatars",
        },
        { connect, lstat },
      ),
    ).rejects.toThrow("PRODUCTION_DATABASE_NAME_INVALID");
    await expect(
      verifyProductionAvatarFiles(
        {
          DATABASE_URL: productionUrl,
          AVATAR_ROOT: "/tmp/avatars",
        },
        { connect, lstat },
      ),
    ).rejects.toThrow("PRODUCTION_AVATAR_ROOT_INVALID");
    expect(connect).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it("prints only a controlled code when the container command fails", () => {
    const script = resolve(
      import.meta.dirname,
      "assert-production-avatar-files.mjs",
    );
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        DATABASE_URL: productionUrl,
        AVATAR_ROOT: "/wrong-avatar-root",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("PRODUCTION_AVATAR_ROOT_INVALID\n");
    expect(result.stderr).not.toContain("never-print-me");
    expect(result.stderr).not.toContain("mysql://");
  });
});
