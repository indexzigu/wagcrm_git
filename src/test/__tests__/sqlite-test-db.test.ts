import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// T-227: the schema engine must never be the one creating the SQLite file.
// Record what the file looked like at the moment `prisma db push` is spawned.
const pushCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined; sizeAtCall: number | null }> = [];

vi.mock("node:child_process", () => ({
  execFileSync: (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    const url = options?.env?.DATABASE_URL ?? "";
    const path = url.replace(/^file:/, "");
    pushCalls.push({ args, env: options?.env, sizeAtCall: existsSync(path) ? statSync(path).size : null });
    return Buffer.from("");
  },
}));

const { pushSqliteTestSchema } = await import("../sqlite-test-db");

let directory: string;

beforeEach(() => {
  pushCalls.length = 0;
  directory = mkdtempSync(join(tmpdir(), "wag-crm-sqlite-test-db-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("pushSqliteTestSchema", () => {
  it("creates a 0-byte file before db push when the file is missing", () => {
    const databasePath = join(directory, "fresh.db");

    pushSqliteTestSchema(databasePath, "/repo");

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].sizeAtCall).toBe(0);
    expect(pushCalls[0].env?.DATABASE_URL).toBe(`file:${databasePath}`);
    expect(pushCalls[0].args.slice(0, 3)).toEqual(["prisma", "db", "push"]);
    expect(pushCalls[0].args).toContain(join("/repo", "prisma", "schema.sqlite.prisma"));
  });

  it("leaves an existing database file untouched", () => {
    const databasePath = join(directory, "existing.db");
    writeFileSync(databasePath, "keep-me");

    pushSqliteTestSchema(databasePath, "/repo");

    expect(pushCalls[0].sizeAtCall).toBe("keep-me".length);
    expect(readFileSync(databasePath, "utf8")).toBe("keep-me");
  });
});

describe("realdb tests provision through pushSqliteTestSchema", () => {
  const sourceRoot = join(process.cwd(), "src");
  const realDbTests = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".realdb.test.ts"))
    .map((file) => join("src", file));

  it("finds the realdb test files", () => {
    expect(realDbTests.length).toBeGreaterThanOrEqual(5);
  });

  it.each(realDbTests)("%s does not call prisma db push directly", (file: string) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).not.toMatch(/"prisma",\s*"db",\s*"push"/);
    expect(source).toContain("pushSqliteTestSchema(");
  });
});
