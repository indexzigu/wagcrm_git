// RLS 커버리지 계약 테스트 (P0 Supabase Data API 잠금, 2026-07-31).
//
// 배경 — **스냅샷 마이그레이션은 한 번만 맞다.**
// `20260715120000_enable_rls_public_tables` 는 2026-07-15 시점에 존재하던 public 테이블
// 57개를 손으로 열거해 RLS 를 켰다. 그 마이그레이션은 다시 돌지 않으므로, 그 뒤에 생긴
// 테이블은 **아무도 켜주지 않는다**. 2026-07-31 실측에서 9개가 그렇게 누락돼 있었다
// (ProductQna·CustomerInquiry·DealVocSource·VocInsightSnapshot·DealStoreLink·
//  BannedPhraseRule·DealClaim·DealOfferAnswer·DealAssetDraft — 전부 07-15 이후 생성).
// 즉 결함은 그 9개가 아니라 **"새 테이블마다 같은 구멍이 재발하는 구조"** 다.
//
// 왜 기존 게이트로는 안 잡히나:
//  - `Migration Guard`(shadow DB)는 ①SQL 이 깨끗이 적용되는가 ②schema.prisma 와
//    동기화됐는가만 본다. RLS 는 **Prisma datamodel 밖**이라 `migrate diff` 가 영원히
//    "무드리프트" 라고 답한다 — 구조적으로 못 잡는다.
//  - Supabase advisor 는 사후 경고고, 대시보드를 봐야 보인다(사람이 안 보면 안 잡힌다).
// 그래서 판정을 레포 안으로 끌어와 **머지 전에** 세운다.
//
// 심각도 주석(2026-07-31 실측): 이 9개는 **라이브 유출이 아니었다**.
// `20260716130000_revoke_public_grants_from_anon` 이 anon 롤의 public 스키마 기본 권한을
// 회수해 둔 상태라 `role_table_grants` 에 anon 행이 0건이었다. 즉 공백은 **심층방어의
// 두 번째 겹**이지 열린 문이 아니었다 — GRANT 가 되돌아오는 순간(수동 복구·새 마이그레이션·
// Supabase 기본값 변경) 받쳐줄 층이 없다는 뜻이다. 이 테스트가 지키는 것은 그 두 번째 겹이다.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SCHEMA_PATH = join(REPO_ROOT, "prisma", "schema.prisma");
const MIGRATIONS_DIR = join(REPO_ROOT, "prisma", "migrations");

/**
 * `schema.prisma` 의 모델 → 실제 테이블명.
 *
 * 현재 이 레포는 `@@map` 을 하나도 쓰지 않아 모델명 == 테이블명이지만, 파서가 그 전제를
 * 붙박이로 갖고 있으면 나중에 누가 `@@map` 을 도입하는 순간 **조용히 잘못된 이름을**
 * 대조하게 된다(있지도 않은 테이블이 "미커버" 로 뜨거나, 반대로 커버된 것으로 오판).
 * 블록을 잘라 `@@map` 을 우선한다.
 */
function readTableNames(): string[] {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const tables: string[] = [];
  // `model X {` … 다음 `\n}` 까지가 한 블록. `view`·`enum` 은 테이블이 아니라 제외한다.
  const blockRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const [, modelName, body] of schema.matchAll(blockRe)) {
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    tables.push(mapped ? mapped[1] : modelName);
  }
  return tables;
}

/**
 * SQL 주석(`--` 라인 · `/* *\/` 블록)을 지운다.
 *
 * ⚠️ **이 단계를 빼면 가드가 우회 가능해진다**(교차검증에서 실제로 재현됨, 2026-07-31):
 * 주석 처리된 `-- ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;` 한 줄이 커버로 집계돼
 * **DB 에는 켜지지 않았는데 테스트는 green** 이 된다. 이 레포의 RLS 마이그레이션들은
 * 배경 설명을 긴 주석으로 다는 관례라(이 파일이 지키는 마이그레이션 3개 전부 그렇다)
 * 템플릿을 복붙하다 주석 해제를 빠뜨리는 경로가 현실적이다.
 *
 * 문자열 리터럴 안의 `--` 까지 지우는 순진한 구현이지만, 그 방향의 오차는 **fail-closed**
 * 다 — 과하게 지우면 실제 ENABLE 문을 놓쳐 "미커버" 로 **실패**하므로 사람이 본다.
 * 반대(과소 제거)만이 조용한 통과를 만들고, 그쪽을 닫는 것이 이 함수의 목적이다.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** 한 마이그레이션 SQL 에서 RLS 가 켜지는 테이블명을 뽑는다(주석은 세지 않는다). */
function collectRlsTables(sql: string): string[] {
  // `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;` — 스키마 한정(`public."X"`)도 허용.
  const re =
    /ALTER\s+TABLE\s+(?:(?:"?public"?)\s*\.\s*)?"?([A-Za-z_][\w$]*)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
  return [...stripSqlComments(sql).matchAll(re)].map(([, table]) => table);
}

/** 전체 마이그레이션 SQL 을 훑어 RLS 가 켜진 테이블 집합을 만든다. */
function readRlsEnabledTables(): Set<string> {
  const enabled = new Set<string>();
  for (const dir of readdirSync(MIGRATIONS_DIR).sort()) {
    const sqlPath = join(MIGRATIONS_DIR, dir, "migration.sql");
    if (!existsSync(sqlPath)) continue;
    for (const table of collectRlsTables(readFileSync(sqlPath, "utf8"))) {
      enabled.add(table);
    }
  }
  return enabled;
}

describe("RLS 커버리지 계약 — 새 테이블은 RLS 를 함께 켠다", () => {
  const tables = readTableNames();
  const rlsEnabled = readRlsEnabledTables();

  it("⚠️ 하네스 양성 대조군 — 파서가 실제로 무언가를 읽었다", () => {
    // 정규식을 리팩터링하다 아무것도 매치하지 않게 되면 "미커버 0건" 이라는 **가짜 통과**가
    // 나온다. 이 테스트의 실패 모드는 그쪽이 훨씬 위험하므로 하한을 먼저 못박는다.
    expect(tables.length).toBeGreaterThan(50);
    expect(rlsEnabled.size).toBeGreaterThan(50);
    // 07-15 스냅샷의 대표 테이블 — 파서가 SQL 을 제대로 훑고 있다는 증거.
    expect(rlsEnabled.has("Seller")).toBe(true);
  });

  it("schema.prisma 의 모든 모델에 ENABLE ROW LEVEL SECURITY 마이그레이션이 있다", () => {
    const missing = tables.filter((t) => !rlsEnabled.has(t));
    expect(
      missing,
      [
        "",
        `RLS 가 켜지지 않은 테이블 ${missing.length}개: ${missing.join(", ")}`,
        "",
        "새 테이블을 만들었다면 **같은 PR 에** RLS 마이그레이션을 추가한다:",
        "",
        "  prisma/migrations/<타임스탬프>_enable_rls_<대상>/migration.sql",
        missing.map((t) => `  ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`).join("\n"),
        "",
        "정책(policy)은 만들지 않는다 — 0개면 anon·authenticated 는 전면 거부되고,",
        "Prisma 가 쓰는 postgres 롤은 소유자라 우회하므로 앱 동작은 변하지 않는다.",
        "FORCE 는 쓰지 않는다(소유자까지 RLS 대상이 되어 Prisma 경로가 깨진다).",
        "자세한 배경은 docs/agents/deployment.md 의 'New Table ⇒ New RLS' 항목.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("⚠️ 음성 대조군 — 존재하지 않는 테이블은 커버된 것으로 취급하지 않는다", () => {
    // 정규식이 지나치게 넓어져(예: 테이블명을 통째로 흘려보내) 무엇이든 매치하면
    // 위 단언이 영원히 통과한다. 그 고장을 여기서 먼저 잡는다.
    expect(rlsEnabled.has("NoSuchTable")).toBe(false);
  });

  it("⚠️ 주석 처리된 ENABLE 문은 커버로 세지 않는다 (우회로 봉쇄)", () => {
    // 교차검증에서 실제로 재현된 우회로: 주석 한 줄이면 DB 는 그대로인데 가드가 통과했다.
    // 파서를 손볼 때 이 단언이 먼저 깨지도록 **인라인 픽스처로** 직접 고정한다
    // (실제 마이그레이션 파일에 의존하면, 그 파일이 바뀌는 순간 이 계약이 조용히 사라진다).
    expect(collectRlsTables(`-- ALTER TABLE "Ghost" ENABLE ROW LEVEL SECURITY;`)).toEqual([]);
    expect(collectRlsTables(`/* ALTER TABLE "Ghost" ENABLE ROW LEVEL SECURITY; */`)).toEqual([]);
    expect(
      collectRlsTables(`/*\n배경 설명 여러 줄\nALTER TABLE "Ghost" ENABLE ROW LEVEL SECURITY;\n*/`),
    ).toEqual([]);

    // 양성 대조군 — 주석 제거가 실문(實文)까지 먹어치우지는 않는다.
    expect(
      collectRlsTables(
        `-- 배경: 아래 한 줄이 본문이다\nALTER TABLE "Real" ENABLE ROW LEVEL SECURITY;`,
      ),
    ).toEqual(["Real"]);
    expect(collectRlsTables(`ALTER TABLE public."Qualified" ENABLE ROW LEVEL SECURITY;`)).toEqual([
      "Qualified",
    ]);
  });

  it("RLS 마이그레이션이 유령 테이블을 켜지 않는다", () => {
    // 반대 방향의 드리프트: 모델을 지웠는데(테이블 DROP) RLS 줄만 남으면, 그 마이그레이션을
    // 빈 DB 에 재적용할 때 `relation does not exist` 로 넘어져 **배포의 자동 migrate 가
    // 통째로 막힌다**(Migration Guard 가 shadow DB 에서 잡아주기는 하나, 여기서 먼저
    // 이유까지 붙여 알려주는 편이 싸다). `_prisma_migrations` 는 Prisma 내부 테이블이라 제외.
    const known = new Set([...tables, "_prisma_migrations"]);
    const ghosts = [...rlsEnabled].filter((t) => !known.has(t));
    expect(
      ghosts,
      `모델이 없는 테이블에 RLS 를 켜고 있다: ${ghosts.join(", ")}`,
    ).toEqual([]);
  });
});
