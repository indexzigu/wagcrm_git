/**
 * sqlite Prisma Client(`prisma/generated/prisma-sqlite`)를 필요할 때만 생성한다.
 *
 * 이 생성물은 **git 미추적**이다. 생성 파일의 `config` 블록에 생성 시점의
 * 머신 절대경로(`output.value` · `sourceFilePath`)와 `.env` 존재 여부에 따라
 * 달라지는 `relativeEnvPaths.schemaEnvPath`가 박히기 때문에, 커밋해 두면 다른
 * 워크트리·세션이 `prisma generate`를 한 번 돌릴 때마다 의미 없는 3파일 수정이
 * 뜨고(경로 치환뿐) 무관한 PR에 섞여 들어간다. 그래서 추적을 끊고, 이 클라이언트를
 * 로드하는 모든 경로가 실행 전에 스스로 생성하도록 이 스크립트를 통과시킨다.
 *
 * 소비 경로(모두 이 스크립트를 먼저 태운다):
 *   - `npm run build` / `build:demo`  — `src/lib/prisma-client.ts`의 정적 import가
 *     번들 시점에 해석돼야 하므로 postgres 프로덕션 빌드에도 필요하다.
 *   - `npm run dev` / `dev:local` / `dev:demo` / `demo:seed`
 *   - `npm run typecheck` — tsc 도 그 정적 import 를 해석해야 한다. 그래서
 *     Definition of Done 이 맨 `npx tsc --noEmit` 대신 이 스크립트를 쓴다(AGENTS.md).
 *   - vitest(`src/test/global-setup.ts`) · `npm run test:e2e`
 *   - `npm ci`/`npm install`(postinstall) — 워크트리는 node_modules를 공유해
 *     install이 돌지 않으므로 postinstall만으로는 부족하다. 위 훅이 본체다.
 *
 * 재생성 판정은 mtime 비교라 최신 상태면 사실상 무비용(수 ms)이다.
 * `--force`로 판정을 무시할 수 있다.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(REPO_ROOT, "prisma", "schema.sqlite.prisma");
const OUTPUT_DIR = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite");

function mtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function isUpToDate() {
  const entrypoint = mtimeMs(join(OUTPUT_DIR, "index.js"));
  // prisma generate는 스키마 사본을 생성물 안에 남긴다 — 그 사본이 원본보다
  // 오래됐으면 스키마가 바뀐 뒤 재생성되지 않은 것이다.
  const schemaCopy = mtimeMs(join(OUTPUT_DIR, "schema.prisma"));
  const schemaSource = mtimeMs(SCHEMA_PATH);
  if (entrypoint === null || schemaCopy === null || schemaSource === null) {
    return false;
  }
  return schemaCopy >= schemaSource;
}

if (isUpToDate() && !process.argv.includes("--force")) {
  process.exit(0);
}

// prisma generate는 datasource URL을 읽지 않는다(실측: DATABASE_URL 미설정·postgres
// URL 양쪽 모두 정상 생성). 따라서 env 주입 없이 어느 경로에서 불려도 안전하다.
execFileSync("npx", ["prisma", "generate", "--schema", SCHEMA_PATH], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});
