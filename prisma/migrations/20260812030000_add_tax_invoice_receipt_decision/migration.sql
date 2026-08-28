-- 수취 세금계산서 1장에 대한 오너의 결정(승인/무관 처리) 기록.
-- 신규 테이블이라 기존 SELECT 를 깨지 않는다(TaxFilingLog 와 같은 형태 — 컬럼 추가가
-- 아니므로 release-preflight 의 P2022 위험이 없다).
CREATE TABLE "TaxInvoiceReceiptDecision" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "matchedKeys" TEXT NOT NULL,
    "observedTotal" INTEGER,
    "expectedTotal" INTEGER,
    "amountDelta" INTEGER,
    "signalSummary" TEXT,
    "appliedDate" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxInvoiceReceiptDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoiceReceiptDecision_issueId_key" ON "TaxInvoiceReceiptDecision"("issueId");

-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」: public 스키마에 테이블을 추가하는 마이그레이션은 같은 PR 에서
-- RLS 를 켠다. 정책은 만들지 않는다 — 0개면 anon·authenticated 전면 거부이고, Prisma 가 쓰는
-- `postgres` 롤은 소유자라 우회하므로 앱 동작 무변화다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "TaxInvoiceReceiptDecision" ENABLE ROW LEVEL SECURITY;
