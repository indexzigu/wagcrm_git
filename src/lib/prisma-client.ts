import { PrismaClient as PostgresPrismaClient } from "@prisma/client";
import { PrismaClient as GeneratedSqlitePrismaClient } from "../../prisma/generated/prisma-sqlite";
import { accessSync, constants, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isDemoMode } from "./demo-mode";
import { READ_ONLY_ENV_KEY, isReadOnlyMode, readOnlyExtension } from "./db-read-only";

const SQLITE_PREFIX = "file:";
const DATABASE_URL = process.env.DATABASE_URL;
const USE_SQLITE_CLIENT =
  isDemoMode() ||
  (typeof DATABASE_URL === "string" && DATABASE_URL.startsWith(SQLITE_PREFIX));

export type AppPrismaClient = PostgresPrismaClient;

export function isSqliteDatabaseUrl(url = process.env.DATABASE_URL) {
  if (isDemoMode()) return true;
  return typeof url === "string" && url.startsWith(SQLITE_PREFIX);
}

/**
 * 연결 문자열이 **명시적으로 원격 DB**(= sqlite 가 아닌 실 DB)를 가리키는가.
 * 이 레포의 `.env` 는 프로덕션 Supabase 를 가리키므로, "로컬 전용이어야 하는 쓰기"
 * (mock 수집 등)를 막는 게이트의 판정식이다.
 *
 * ⚠️ **미설정·빈 문자열은 원격으로 보지 않는다.** 연결 문자열이 없으면 Prisma 가
 * 애초에 붙지 못해 오염 경로가 아니고(쿼리 시점에 스스로 시끄럽게 실패한다),
 * 반대로 원격으로 취급하면 DB 를 안 쓰는 단위 테스트·CLI 가 이유 없이 막힌다.
 * `createPrismaClient` 의 데모 모드 가드가 이미 같은 판정("비어있지 않고 file: 이
 * 아닐 때만 거부")을 쓴다 — 같은 규칙을 두 곳이 각자 쓰지 않게 여기로 모은다.
 */
export function isRemoteDatabaseUrl(url = process.env.DATABASE_URL) {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (trimmed === "") return false;
  return !isSqliteDatabaseUrl(trimmed);
}

const SqlitePrismaClient: typeof PostgresPrismaClient | null = USE_SQLITE_CLIENT
  ? (GeneratedSqlitePrismaClient as unknown as typeof PostgresPrismaClient)
  : null;

// 데모 배포(외부 시연용)의 목업 DB. 시드는 빌드 시점에 이 경로로 생성되고,
// 런타임 FS가 읽기 전용(Vercel 함수)이면 /tmp 사본으로 열어 sqlite가
// 저널 생성조차 못 해 열기부터 실패하는 것을 피한다(사본은 인스턴스 수명 = 휘발).
const DEMO_DB_FILENAME = "demo.db";

function resolveDemoDatasourceUrl(): string {
  const bundledPath = path.join(process.cwd(), "prisma", DEMO_DB_FILENAME);
  let bundledWritable = true;
  try {
    accessSync(bundledPath, constants.W_OK);
  } catch {
    bundledWritable = false;
  }
  if (bundledWritable) {
    return `${SQLITE_PREFIX}${bundledPath}`;
  }
  if (!existsSync(bundledPath)) {
    throw new Error(
      `[Prisma] 데모 모드인데 목업 DB(${bundledPath})가 없습니다. build:demo로 시드된 배포인지 확인하세요.`,
    );
  }
  const tmpPath = path.join("/tmp", DEMO_DB_FILENAME);
  if (!existsSync(tmpPath)) {
    copyFileSync(bundledPath, tmpPath);
  }
  return `${SQLITE_PREFIX}${tmpPath}`;
}

/**
 * 읽기 전용 레인(`DB_READ_ONLY=1`)이면 쓰기 차단 확장을 씌운다 — 세 갈래(데모·sqlite·
 * postgres) 어디로 빠지든 **같은 한 곳**에서 씌워야 레인 하나가 조용히 빠지지 않는다.
 *
 * DB 종류를 가리지 않는 것은 의도다: 위험의 실체는 "어떤 DB 냐"가 아니라 "이 세션이
 * 쓰기를 의도했느냐"이고, 레인 선택은 이미 스크립트(`dev:ro`)에서 끝났다.
 *
 * `$extends` 는 원본과 다른 타입을 돌려주지만 런타임 표면은 동일하다. 호출부 전체가
 * `AppPrismaClient` 로 서 있으므로 여기서 한 번만 좁힌다 — 대안은 앱 전체를 확장 타입으로
 * 물들이는 것인데, 가드가 꺼진 세션에서는 존재하지도 않는 타입이라 성립하지 않는다.
 */
function withReadOnlyGuard(client: AppPrismaClient): AppPrismaClient {
  if (!isReadOnlyMode()) return client;
  console.log(`[Prisma] 읽기 전용 모드 — Prisma 경유 쓰기를 차단합니다(${READ_ONLY_ENV_KEY}=1)`);
  return client.$extends(readOnlyExtension) as unknown as AppPrismaClient;
}

export function createPrismaClient(): AppPrismaClient {
  return withReadOnlyGuard(createBasePrismaClient());
}

function createBasePrismaClient(): AppPrismaClient {
  console.log("[Prisma] createPrismaClient resolved:", {
    databaseProvider: USE_SQLITE_CLIENT ? "sqlite" : "postgres",
    USE_SQLITE_CLIENT,
    hasSqliteClient: !!SqlitePrismaClient,
    demoMode: isDemoMode(),
  });
  if (isDemoMode()) {
    // 안전 불변식: 데모 모드(인증 우회)는 sqlite 목업 전용이다. postgres URL이 섞여
    // 들어오면(실DB 오설정) 조용히 붙지 말고 기동 자체를 거부한다.
    if (typeof DATABASE_URL === "string" && DATABASE_URL.length > 0 && !DATABASE_URL.startsWith(SQLITE_PREFIX)) {
      throw new Error(
        "[Prisma] DEMO_MODE=1인데 DATABASE_URL이 sqlite(file:)가 아닙니다. 데모 모드는 실DB 연결을 금지합니다.",
      );
    }
    if (!SqlitePrismaClient) {
      throw new Error("[Prisma] 데모 모드인데 sqlite 클라이언트가 로드되지 않았습니다.");
    }
    return new SqlitePrismaClient({ datasourceUrl: resolveDemoDatasourceUrl() });
  }
  if (USE_SQLITE_CLIENT && SqlitePrismaClient) {
    console.log("[Prisma] Using SQLite Prisma Client");
    return new SqlitePrismaClient();
  }
  console.log("[Prisma] Using Postgres Prisma Client");
  return new PostgresPrismaClient();
}
