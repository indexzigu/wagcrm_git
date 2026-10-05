import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Push prisma/schema.sqlite.prisma into a SQLite file for tests that hit a real DB
 * (`*.realdb.test.ts` and the vitest global setup's dev.db).
 *
 * The file is created as 0 bytes BEFORE `prisma db push` runs — the same step
 * scripts/sqlite-push.ts takes. SQLite treats an empty file as a valid empty
 * database, so the push only opens it and fills the schema.
 *
 * Why (T-227): letting the Prisma schema engine create a missing file is the only
 * step that differs between "file missing" and "file present", and in some local
 * environments it fails with a bare `Error: Schema engine error:` (no detail) while
 * the same push onto a pre-created file succeeds. Observed 2026-09-29 in a Codex
 * session (worktree and main checkout alike, absolute and relative paths alike);
 * not reproducible from Claude Code, Codex's own sandbox, or a core-only env.
 * Root cause unconfirmed — pre-creating removes the dependency on that step.
 *
 * An existing file is left untouched (dev.db keeps its data across runs).
 */
export function pushSqliteTestSchema(
  databasePath: string,
  repositoryRoot: string = process.cwd(),
): void {
  if (!existsSync(databasePath)) {
    writeFileSync(databasePath, "");
  }

  execFileSync(
    "npx",
    [
      "prisma",
      "db",
      "push",
      "--schema",
      join(repositoryRoot, "prisma", "schema.sqlite.prisma"),
      "--skip-generate",
      "--accept-data-loss",
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
      stdio: "pipe",
    },
  );
}
