-- 자사몰 공급사 지급 레그(2번째 지급 일정) — 카드 슬롯 SSOT: resolveCampaignMoneySlots
-- AlterTable
ALTER TABLE "SalesCampaign" ADD COLUMN     "expectedSupplierPayoutDate" TIMESTAMP(3),
ADD COLUMN     "isSupplierPayoutCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplierPayoutCompletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CampaignGroup" ADD COLUMN     "expectedSupplierPayoutDate" TIMESTAMP(3),
ADD COLUMN     "isSupplierPayoutCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supplierPayoutCompletedAt" TIMESTAMP(3);
