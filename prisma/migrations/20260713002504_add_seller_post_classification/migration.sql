-- CreateTable
CREATE TABLE "SellerPostClassification" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "permalink" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'UNREVIEWED',
    "classifiedAt" TIMESTAMP(3),
    "salesCampaignId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerPostClassification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SellerPostClassification_classification_idx" ON "SellerPostClassification"("classification");

-- CreateIndex
CREATE INDEX "SellerPostClassification_sellerId_idx" ON "SellerPostClassification"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerPostClassification_sellerId_permalink_key" ON "SellerPostClassification"("sellerId", "permalink");

-- AddForeignKey
ALTER TABLE "SellerPostClassification" ADD CONSTRAINT "SellerPostClassification_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

