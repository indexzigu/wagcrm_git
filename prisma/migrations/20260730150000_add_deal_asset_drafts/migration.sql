-- CreateTable
CREATE TABLE "DealAssetDraft" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CONTENT_GUIDE',
    "body" TEXT NOT NULL,
    "gateVerdict" TEXT NOT NULL,
    "claimIds" TEXT,
    "proofCardIncluded" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealAssetDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealAssetDraft_dealId_sentAt_idx" ON "DealAssetDraft"("dealId", "sentAt");

-- AddForeignKey
ALTER TABLE "DealAssetDraft" ADD CONSTRAINT "DealAssetDraft_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
