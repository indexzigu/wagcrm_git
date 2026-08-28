-- CreateTable
CREATE TABLE "ProductQna" (
    "questionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "dealId" TEXT,
    "productName" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "writerMasked" TEXT,
    "createDate" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductQna_pkey" PRIMARY KEY ("questionId")
);

-- CreateTable
CREATE TABLE "CustomerInquiry" (
    "inquiryNo" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "answerAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT NOT NULL,
    "productNo" TEXT,
    "productOrderIds" TEXT NOT NULL,
    "optionText" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerInquiry_pkey" PRIMARY KEY ("inquiryNo")
);

-- CreateIndex
CREATE INDEX "ProductQna_dealId_createDate_idx" ON "ProductQna"("dealId", "createDate");

-- CreateIndex
CREATE INDEX "ProductQna_answered_idx" ON "ProductQna"("answered");

-- CreateIndex
CREATE INDEX "ProductQna_productId_idx" ON "ProductQna"("productId");

-- CreateIndex
CREATE INDEX "CustomerInquiry_registeredAt_idx" ON "CustomerInquiry"("registeredAt");

-- CreateIndex
CREATE INDEX "CustomerInquiry_answered_idx" ON "CustomerInquiry"("answered");

