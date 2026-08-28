-- CreateTable
CREATE TABLE "VocInsightSnapshot" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "rangeFrom" TIMESTAMP(3),
    "rangeTo" TIMESTAMP(3),
    "qnaCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "model" TEXT,
    "promptVersion" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "lastError" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VocInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VocInsightSnapshot_dealId_key" ON "VocInsightSnapshot"("dealId");

-- CreateIndex
CREATE INDEX "VocInsightSnapshot_generatedAt_idx" ON "VocInsightSnapshot"("generatedAt");

