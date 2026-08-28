// Vercel production 배포 시에만 실 DB에 대기 중인 Prisma 마이그레이션을 적용한다.
//
// 배경: prod = origin/main 머지 → Vercel Git 자동배포. 신규 마이그레이션이 실
// Supabase DB에 미적용된 채 코드가 살아나면 P2022(스키마 불일치) 전면 장애가
// 난다. 이 스크립트를 build 커맨드 맨 앞에 두어, 새 코드가 트래픽을 받기 전에
// 마이그레이션이 먼저 적용되도록 강제한다(마이그레이션 실패 → build 실패 →
// 배포 중단 → 기존 코드 유지 = fail-safe).
//
// 안전 가드:
//  - VERCEL_ENV !== 'production' 이면 건너뛴다. → 로컬 `npm run build`,
//    Vercel preview 배포, GitHub Release Preflight(VERCEL_ENV 미설정)에서는
//    실 DB를 절대 건드리지 않는다.
//  - migrate deploy는 이미 적용된 마이그레이션엔 무영향(멱등)이고, 동시 실행은
//    Prisma의 advisory lock으로 직렬화된다.
//  - migrate deploy는 세션 연결이 필요하므로 pgBouncer 풀러(DATABASE_URL)가
//    아니라 DIRECT_URL(직결)을 써야 한다. schema.prisma의 directUrl 설정을
//    Prisma가 migrate 계열 명령에서 자동 사용한다.

import { execFileSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV;

if (vercelEnv !== "production") {
  console.log(
    `[migrate-on-deploy] VERCEL_ENV=${vercelEnv ?? "(unset)"} — production 배포가 아니므로 migrate deploy를 건너뜁니다.`,
  );
  process.exit(0);
}

// 데모 배포(sqlite 목업)는 postgres 마이그레이션 대상이 아니다 — 데모 프로젝트가
// 빌드 커맨드 오버라이드(build:demo)를 빠뜨려도 실DB를 건드리지 않게 여기서도 막는다.
if (
  process.env.DEMO_MODE === "1" ||
  (process.env.DATABASE_URL ?? "").startsWith("file:")
) {
  console.log(
    "[migrate-on-deploy] DEMO_MODE/sqlite(file:) 환경 — 데모 배포이므로 migrate deploy를 건너뜁니다.",
  );
  process.exit(0);
}

if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) {
  console.error(
    "[migrate-on-deploy] DIRECT_URL/DATABASE_URL이 모두 없습니다 — 마이그레이션을 적용할 수 없어 배포를 중단합니다.",
  );
  process.exit(1);
}

if (!process.env.DIRECT_URL) {
  console.warn(
    "[migrate-on-deploy] ⚠️ DIRECT_URL이 없습니다. Supabase 풀러(DATABASE_URL, pgBouncer)로는 migrate deploy가 실패할 수 있습니다. Vercel production 환경변수에 DIRECT_URL(직결 5432)을 설정하세요.",
  );
}

// Prisma는 migrate 계열 명령에서 directUrl(있으면)을, 없으면 url을 쓴다.
// 그 연결이 트랜잭션 풀러(pgBouncer, 6543)면 migrate deploy가 세션 락/prepared
// statement를 못 써서 크립틱하게 실패한다. 여기서 미리 잡아 명확히 알린다.
const migrateUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
try {
  const parsed = new URL(migrateUrl);
  const isTransactionPooler =
    parsed.port === "6543" ||
    parsed.searchParams.get("pgbouncer") === "true";
  if (isTransactionPooler) {
    console.error(
      "[migrate-on-deploy] ❌ 마이그레이션 연결이 트랜잭션 풀러(포트 6543 / pgbouncer=true)입니다. " +
        "이 연결로는 migrate deploy가 실패합니다. Vercel production의 DIRECT_URL을 " +
        "세션 모드(포트 5432, 직결 db.*.supabase.co 또는 5432 세션 풀러)로 바꾸세요. 배포를 중단합니다.",
    );
    process.exit(1);
  }
} catch {
  console.warn(
    "[migrate-on-deploy] ⚠️ 마이그레이션 연결 URL을 파싱하지 못해 포트 사전검사를 건너뜁니다. prisma migrate deploy 결과로 판단합니다.",
  );
}

console.log("[migrate-on-deploy] production 배포 — prisma migrate deploy 실행");

try {
  execFileSync(
    "prisma",
    ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
    { stdio: "inherit" },
  );
} catch (error) {
  console.error(
    "[migrate-on-deploy] ❌ prisma migrate deploy 실패 — 배포를 중단합니다(기존 코드 유지).",
  );
  process.exit(error.status ?? 1);
}

console.log("[migrate-on-deploy] ✅ 마이그레이션 적용 완료");
