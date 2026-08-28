-- 캠페인 정산 부가 항목 — 「매출 × 요율」 파생 밖에서 움직이는 돈의 명세.
-- 설계 정본: docs/superpowers/specs/2026-08-07-settlement-money-separation-design.md
--
-- 신규 테이블이라 기존 SELECT 를 깨지 않는다(release-preflight 의 P2022 위험 없음).
-- 기존 컬럼 변경·데이터 이관이 없는 순수 additive 마이그레이션이며, 평소 0행이
-- 정상이라 착지 시점의 화면 변화도 없다(포워드 전용 — 설계 §7).
CREATE TABLE "CampaignSettlementItem" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "invoiceMode" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignSettlementItem_campaignId_idx" ON "CampaignSettlementItem"("campaignId");

-- AddForeignKey
ALTER TABLE "CampaignSettlementItem" ADD CONSTRAINT "CampaignSettlementItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」: public 스키마에 테이블을 추가하는 마이그레이션은 같은 PR 에서
-- RLS 를 켠다. 정책은 만들지 않는다 — 0개면 anon·authenticated 전면 거부이고, Prisma 가 쓰는
-- `postgres` 롤은 소유자라 우회하므로 **앱 동작 무변화**다. `FORCE` 는 쓰지 않는다(소유자까지
-- 대상이 되어 Prisma 경로가 깨진다). 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CampaignSettlementItem" ENABLE ROW LEVEL SECURITY;
