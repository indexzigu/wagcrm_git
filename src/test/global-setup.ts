import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pushSqliteTestSchema } from "./sqlite-test-db";

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
 * The push itself goes through pushSqliteTestSchema (./sqlite-test-db), shared
 * with the realdb tests: it pre-creates the file with node like
 * scripts/sqlite-push.ts does, so the setup needs neither npm-script env wiring
 * nor the sqlite3 CLI.
 *
 * It also provisions the generated sqlite Prisma Client. That client is
 * gitignored (see scripts/ensure-sqlite-client.mjs for why), and the realdb
 * tests import prisma/generated/prisma-sqlite/index.js directly — so a fresh
 * clone or worktree would fail with ERR_MODULE_NOT_FOUND without this. Doing it
 * here rather than in a `pretest` hook keeps a bare `npx vitest` working too.
 */
export default function setup(): void {
  const dbPath = join(process.cwd(), "prisma", "dev.db");

  execFileSync(
    process.execPath,
    [join(process.cwd(), "scripts", "ensure-sqlite-client.mjs")],
    { stdio: "inherit" },
  );

  mkdirSync(dirname(dbPath), { recursive: true });
  pushSqliteTestSchema(dbPath);
}
