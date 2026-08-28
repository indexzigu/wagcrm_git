-- CreateTable
CREATE TABLE "DealStoreLink" (
    "dealId" TEXT NOT NULL,
    "shortLink" TEXT NOT NULL,
    "channelProductNo" TEXT,
    "originProductNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESOLVED',
    "lastError" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealStoreLink_pkey" PRIMARY KEY ("dealId")
);

-- CreateIndex
CREATE INDEX "DealStoreLink_originProductNo_idx" ON "DealStoreLink"("originProductNo");

-- CreateIndex
CREATE INDEX "DealStoreLink_status_idx" ON "DealStoreLink"("status");

