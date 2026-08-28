import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Vitest global setup — runs ONCE before the whole suite.
 *
 * The kakao txt-ingest idempotency test (src/lib/kakao/__tests__/…​) exercises
 * the real SQLite dev.db (WorkRecord / ChatRoomMapping tables). `npm test`
 * (= `vitest run`) previously did not push the schema — only `npm run test:e2e`
 * did — so a fresh worktree or CI failed with "table WorkRecord does not exist".
 * Pushing the sqlite schema here makes `npm test` self-contained. dev.db stays
 * gitignored; this just (re)provisions it locally.
 *
 * Mirrors scripts/sqlite-push.ts (kept in sync intentionally) so the setup has
 * no dependency on npm-script env wiring.
 *
 * It also provisions the generated sqlite Prisma Client. That client is
 * gitignored (see scripts/ensure-sqlite-client.mjs for why), and the realdb
 * tests import prisma/generated/prisma-sqlite/index.js directly — so a fresh
 * clone or worktree would fail with ERR_MODULE_NOT_FOUND without this. Doing it
 * here rather than in a `pretest` hook keeps a bare `npx vitest` working too.
 */
export default function setup(): void {
  const dbPath = join(process.cwd(), "prisma", "dev.db");
  const schemaPath = join(process.cwd(), "prisma", "schema.sqlite.prisma");
  const databaseUrl = "file:./dev.db";

  execFileSync(
    process.execPath,
    [join(process.cwd(), "scripts", "ensure-sqlite-client.mjs")],
    { stdio: "inherit" },
  );

  mkdirSync(dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    execFileSync("sqlite3", [dbPath, "VACUUM;"], { stdio: "inherit" });
  }

  execFileSync(
    "npx",
    [
      "prisma",
      "db",
      "push",
      "--schema",
      schemaPath,
      "--skip-generate",
      "--accept-data-loss",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
}
