-- 월별 정산 줄(T-240) — 월정산 거래처의 브랜드 정산을 캠페인 안에서 월별로 기록한다.
-- 설계 정본: docs/private/specs/2026-10-08-monthly-settlement-lines-design.md
--
-- 순수 additive 다: 신규 테이블 1개 + Partner 에 기본값 false 컬럼 1개. 기존 SELECT 를 깨지 않고
-- (release-preflight 의 P2022 위험 없음) 착지 시점의 화면 변화도 없다 — 월정산 플래그가 전부 꺼진
-- 채로 태어나기 때문이다. ⛔ 기존 캠페인 데이터 이전을 이 SQL 에 넣지 않는다(명세 「사람 검수 없는
-- 자동 실행 금지」): 이전은 오너가 거래처에서 월정산을 켤 때 서비스가 그 거래처 캠페인에만 한다.
-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "monthlySettlement" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CampaignMonthlySettlement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "quantity" INTEGER,
    "transactionAmount" DECIMAL(65,30),
    "commissionRate" DECIMAL(65,30),
    "commissionAmount" DECIMAL(65,30),
    "supplyAmount" DECIMAL(65,30),
    "vat" DECIMAL(65,30),
    "salesInvoiceIssuedAt" TIMESTAMP(3),
    "salesInvoiceNo" TEXT,
    "salesInvoiceItemName" TEXT,
    "purchaseInvoiceReceivedAt" TIMESTAMP(3),
    "goodsAmount" DECIMAL(65,30),
    "paymentAmount" DECIMAL(65,30),
    "paymentDueDate" TIMESTAMP(3),
    "paymentPaidAt" TIMESTAMP(3),
    "salesInvoiceCheckedAt" TIMESTAMP(3),
    "purchaseInvoiceCheckedAt" TIMESTAMP(3),
    "paymentScheduleCheckedAt" TIMESTAMP(3),
    "paymentCompletedCheckedAt" TIMESTAMP(3),
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignMonthlySettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignMonthlySettlement_yearMonth_idx" ON "CampaignMonthlySettlement"("yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignMonthlySettlement_campaignId_yearMonth_key" ON "CampaignMonthlySettlement"("campaignId", "yearMonth");

-- AddForeignKey
ALTER TABLE "CampaignMonthlySettlement" ADD CONSTRAINT "CampaignMonthlySettlement_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CampaignMonthlySettlement" ENABLE ROW LEVEL SECURITY;
