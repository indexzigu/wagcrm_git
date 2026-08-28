import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const rawUrl =
  process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith("file:")
    ? process.env.DATABASE_URL
    : "file:./dev.db";

const dbRelativePath = rawUrl.replace(/^file:/, "");
const dbPath = join(process.cwd(), "prisma", dbRelativePath.replace(/^\.\//, ""));
const schemaPath = join(process.cwd(), "prisma", "schema.sqlite.prisma");

mkdirSync(dirname(dbPath), { recursive: true });
if (!existsSync(dbPath)) {
  // 0바이트 파일은 SQLite가 유효한 "빈 데이터베이스"로 취급하므로, 이어지는
  // `prisma db push`가 그 위에 스키마를 채운다. 예전엔 sqlite3 CLI로 VACUUM을 돌려
  // 초기화했으나, 서버리스 빌드 머신(Vercel demo:seed)엔 sqlite3 바이너리가 없어
  // spawnSync ENOENT로 빌드가 죽었다 — node 네이티브 파일 생성으로 의존을 제거한다.
  writeFileSync(dbPath, "");
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
    env: {
      ...process.env,
      DATABASE_URL: rawUrl,
    },
  },
);

console.log(`SQLite schema is ready at ${dbPath}`);
