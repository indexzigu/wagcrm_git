-- 캠페인 계산서(T-240 후속) — 월정산 거래처의 공급사 계산서를 캠페인당 여러 장 기록한다.
-- 설계 정본: docs/private/specs/2026-10-08-invoice-autofill-flow.md (+ -design-critique.md)
--
-- 순수 additive 다: 신규 테이블 1개. 기존 SELECT 를 깨지 않고(release-preflight 의 P2022 위험 없음)
-- 착지 시점의 데이터 변화도 없다 — 행은 오너가 계산서를 확인할 때만 생긴다.
-- ⛔ #159 의 CampaignMonthlySettlement 행을 이 SQL 로 옮기거나 지우지 않는다(명세 「사람 검수 없는
-- 자동 실행 금지」). 그 테이블은 이 PR 부터 아무도 쓰지 않으며, 정리는 오너 확인 후 별도로 한다.
-- CreateTable
CREATE TABLE "CampaignInvoice" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3),
    "approvalNo" TEXT,
    "supplyAmount" INTEGER,
    "taxAmount" INTEGER,
    "totalAmount" INTEGER,
    "itemName" TEXT,
    "source" TEXT NOT NULL,
    "mailReceivedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignInvoice_campaignId_yearMonth_idx" ON "CampaignInvoice"("campaignId", "yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignInvoice_campaignId_approvalNo_key" ON "CampaignInvoice"("campaignId", "approvalNo");

-- AddForeignKey
ALTER TABLE "CampaignInvoice" ADD CONSTRAINT "CampaignInvoice_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CampaignInvoice" ENABLE ROW LEVEL SECURITY;
