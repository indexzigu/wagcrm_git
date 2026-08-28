-- CreateTable
CREATE TABLE "DealVocSource" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "productUrl" TEXT,
    "originProductNo" TEXT,
    "channelProductNo" TEXT,
    "driveFileId" TEXT,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCounts" TEXT,
    "photoCount" INTEGER NOT NULL DEFAULT 0,
    "latestReviewAt" TIMESTAMP(3),
    "previewJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastCollectedAt" TIMESTAMP(3),
    "lastCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealVocSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealVocSource_dealId_idx" ON "DealVocSource"("dealId");

-- CreateIndex
CREATE INDEX "DealVocSource_status_idx" ON "DealVocSource"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DealVocSource_dealId_channel_key" ON "DealVocSource"("dealId", "channel");

