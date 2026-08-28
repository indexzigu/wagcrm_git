// 콘텐츠 가이드 **초안 스냅샷** 계약 (2026-08-01).
//
// 배경: 생성 라우트는 원래 stateless 라, 딜을 잠깐 바꿨다 돌아오면 초안이 사라지고
// 다시 누르면 **다른 결과**가 나왔다(모델 비결정성 + Gemini 2발 비용). 최신 1건을
// 보존하기로 했는데, 이때 **어디에 저장하는가**가 설계의 핵심이었다.
//
// ⚠️ 이 파일이 지키는 것은 "초안과 보낸 자료를 섞지 않는다" 하나다.
// `DealAssetDraft` 는 **보낸 자료의 감사 기록**이고 `launch-readiness` 가 그 행의
// 존재로 "가이드를 보냈는가"를 판정한다. 초안을 거기 넣으면 **아직 아무한테도 안 보낸
// 초안이 '보냄 완료'로 집혀** 캠페인 준비 체크가 거짓 초록불이 된다. 설계 검토에서
// 이 이유로 status 컬럼 안을 기각하고 테이블을 갈랐다 — 그 판단을 기계로 고정한다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const SCHEMA = read("prisma/schema.prisma");
const SQLITE_SCHEMA = read("prisma/schema.sqlite.prisma");
const GUIDE_ROUTE = read("src/app/api/deals/[id]/content-guide/route.ts");
const READINESS_ROUTE = read(
  "src/app/api/campaigns/[id]/launch-readiness/route.ts",
);

/** `model X { ... }` 블록만 잘라낸다. */
function modelBlock(schema: string, name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `${name} 모델이 없다`).toBeGreaterThan(-1);
  return schema.slice(start, schema.indexOf("\n}", start));
}

describe("초안과 보낸 자료는 다른 테이블이다", () => {
  it("`DealGuideDraft` 가 존재하고 딜×종류로 유니크다 — 딜당 1행", () => {
    const block = modelBlock(SCHEMA, "DealGuideDraft");
    expect(block).toContain("@@unique([dealId, kind])");
  });

  it("초안 테이블에 `sentAt` 이 없다 — 보낸 시각은 감사 기록의 개념이다", () => {
    expect(modelBlock(SCHEMA, "DealGuideDraft")).not.toContain("sentAt");
  });

  it("`DealAssetDraft` 에 초안 구분 컬럼이 생기지 않았다 — 섞지 않기로 한 결정", () => {
    const block = modelBlock(SCHEMA, "DealAssetDraft");
    expect(block).not.toContain("status");
    // 여전히 append-only 감사 기록이어야 한다.
    expect(block).toContain("sentAt");
  });

  it("캠페인 준비 판정은 여전히 `DealAssetDraft` 만 본다 — 초안이 섞이면 거짓 초록불", () => {
    expect(READINESS_ROUTE).toContain("dealAssetDraft");
    expect(
      READINESS_ROUTE,
      "준비 판정이 초안 테이블을 읽으면 안 보낸 초안이 '보냄 완료'로 집힌다",
    ).not.toContain("dealGuideDraft");
  });

  it("postgres·sqlite 스키마가 함께 갱신됐다 — 한쪽만 고치면 로컬이 깨진다", () => {
    expect(SQLITE_SCHEMA).toContain("model DealGuideDraft");
    expect(modelBlock(SQLITE_SCHEMA, "DealGuideDraft")).toContain(
      "@@unique([dealId, kind])",
    );
  });
});

describe("마이그레이션", () => {
  const MIGRATION = read(
    "prisma/migrations/20260801150000_add_deal_guide_draft/migration.sql",
  );

  it("새 테이블은 RLS 를 함께 켠다 (P6 「New Table ⇒ New RLS」)", () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "DealGuideDraft" ENABLE ROW LEVEL SECURITY;',
    );
    // FORCE 는 소유자까지 대상이 되어 Prisma 경로가 깨진다.
    expect(MIGRATION).not.toContain("FORCE ROW LEVEL SECURITY");
  });

  it("기존 테이블을 건드리지 않는다 — 되돌리려면 새 테이블만 지우면 된다", () => {
    expect(MIGRATION).not.toContain("DealAssetDraft");
    expect(MIGRATION).not.toMatch(/ALTER TABLE "Deal"\s/);
  });
});

describe("라우트 규약", () => {
  it("초안 저장이 생성을 깨뜨리지 않는다 — upsert 가 try 안에 있다", () => {
    const at = GUIDE_ROUTE.indexOf("dealGuideDraft.upsert");
    expect(at).toBeGreaterThan(-1);
    // upsert 앞쪽에 try 가 있고, 바로 뒤 catch 가 콘솔로만 남기는지 본다.
    const before = GUIDE_ROUTE.slice(0, at);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(
      before.lastIndexOf("} catch"),
    );
    const after = GUIDE_ROUTE.slice(at, at + 900);
    expect(after).toContain("catch");
    expect(after).toContain("console.error");
  });

  it("복원 시 표현 검사를 다시 계산한다 — 저장된 판정은 낡을 수 있다", () => {
    const getAt = GUIDE_ROUTE.indexOf("export async function GET");
    expect(getAt).toBeGreaterThan(-1);
    const getBody = GUIDE_ROUTE.slice(getAt);
    expect(getBody).toContain("checkText(");
    expect(getBody).toContain("bannedPhraseRule.findMany");
  });

  it("복원 응답이 딜 변경 여부를 함께 준다 — 시각만으로는 낡음을 알 수 없다", () => {
    const getBody = GUIDE_ROUTE.slice(
      GUIDE_ROUTE.indexOf("export async function GET"),
    );
    expect(getBody).toContain("dealChangedAfter");
    expect(getBody).toContain("savedAt");
  });
});
