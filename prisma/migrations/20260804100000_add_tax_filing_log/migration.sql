-- 원천징수 3절차(원천세 신고·지급명세 제출·지방소득세 특별징수)의 월별 완료 기록.
-- 신규 테이블이라 기존 SELECT 를 깨지 않는다 — Seller 처럼 ISR 프리렌더가 읽는
-- 테이블에 컬럼을 추가하는 것과 달리 release-preflight 의 P2022 위험이 없다
-- (세무 신고자료 도우미 설계 문서 「✅ 업종구분코드」절 참조).
CREATE TABLE "TaxFilingLog" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxFilingLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxFilingLog_month_kind_key" ON "TaxFilingLog"("month", "kind");

-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」: public 스키마에 테이블을 추가하는 마이그레이션은 같은 PR 에서
-- RLS 를 켠다. 정책은 만들지 않는다 — 0개면 anon·authenticated 전면 거부이고, Prisma 가 쓰는
-- `postgres` 롤은 소유자라 우회하므로 **앱 동작 무변화**다. `FORCE` 는 쓰지 않는다(소유자까지
-- 대상이 되어 Prisma 경로가 깨진다). 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "TaxFilingLog" ENABLE ROW LEVEL SECURITY;
