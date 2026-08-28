-- AlterTable
ALTER TABLE "OrderCampaign" ADD COLUMN     "cachedPostCloseCancelQuantity" INTEGER DEFAULT 0,
ADD COLUMN     "cachedPostCloseCancelRevenue" INTEGER DEFAULT 0;
