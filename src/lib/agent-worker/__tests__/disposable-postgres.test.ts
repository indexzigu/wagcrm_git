/**
 * Hermetic cover for the guard that keeps `worker-role-privileges.realpg.test.ts` off
 * production. That test is opt-in and skipped by `npm run test:ci`, so a guard written
 * inside it would ship unverified — the one state in which a guard is worth nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDisposablePostgresUrl, readConfiguredDatabaseUrls } from "./support/disposable-postgres";

const DISPOSABLE = "postgresql://127.0.0.1:54999/postgres";
const PRODUCTION = "postgresql://127.0.0.1:55432/postgres";

describe("assertDisposablePostgresUrl", () => {
  it("accepts a loopback throw-away port when nothing configured shares its endpoint", async () => {
    await expect(assertDisposablePostgresUrl(DISPOSABLE, [PRODUCTION])).resolves.toBeUndefined();
  });

  it("refuses databases off loopback", async () => {
    await expect(assertDisposablePostgresUrl("postgresql://db.example.invalid:54999/postgres", [])).rejects.toThrow(
      /non-loopback/,
    );
  });

  it.each(["55432", "5432", "6543"])("refuses the self-hosted production port %s", async (port) => {
    await expect(assertDisposablePostgresUrl(`postgresql://127.0.0.1:${port}/postgres`, [])).rejects.toThrow(
      /production ports/,
    );
  });

  it("refuses an endpoint this repository is configured against, whatever port it moves to", async () => {
    const moved = "postgresql://127.0.0.1:54999/postgres";
    await expect(assertDisposablePostgresUrl(moved, [moved])).rejects.toThrow(/configured against/);
  });

  it("does not treat a configured sqlite url as a production endpoint", async () => {
    await expect(assertDisposablePostgresUrl(DISPOSABLE, ["file:./dev.db", ""])).resolves.toBeUndefined();
  });
});

describe("readConfiguredDatabaseUrls", () => {
  it("collects DATABASE_URL and DIRECT_URL out of the repository .env", () => {
    const root = mkdtempSync(join(tmpdir(), "wag-crm-disposable-"));
    try {
      writeFileSync(
        join(root, ".env"),
        ['DATABASE_URL="postgresql://127.0.0.1:55432/postgres"', "export DIRECT_URL=postgresql://127.0.0.1:5432/postgres", "OTHER=x"].join(
          "\n",
        ),
      );
      expect(readConfiguredDatabaseUrls(root)).toEqual(
        expect.arrayContaining([
          "postgresql://127.0.0.1:55432/postgres",
          "postgresql://127.0.0.1:5432/postgres",
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contributes nothing when the repository has no .env", () => {
    const root = mkdtempSync(join(tmpdir(), "wag-crm-disposable-"));
    try {
      const ambient = [process.env.DATABASE_URL, process.env.DIRECT_URL].filter(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      expect(readConfiguredDatabaseUrls(root)).toEqual(ambient);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("worker-role-privileges.realpg.test.ts", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/agent-worker/__tests__/worker-role-privileges.realpg.test.ts"), "utf8");

  it("drops the role it creates", () => {
    expect(source).toMatch(/CREATE ROLE wag_agent_worker/);
    expect(source).toMatch(/DROP ROLE wag_agent_worker/);
  });

  it("never adopts or alters a role it did not create", () => {
    expect(source).not.toMatch(/IF NOT EXISTS[^;]*CREATE ROLE/);
    expect(source).not.toMatch(/ALTER ROLE wag_agent_worker/);
  });
});
