-- CreateEnum
CREATE TYPE "OfferAnswerVerdict" AS ENUM ('PASS', 'FAIL', 'UNKNOWN');

-- CreateTable
CREATE TABLE "DealOfferAnswer" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "verdict" "OfferAnswerVerdict" NOT NULL DEFAULT 'UNKNOWN',
    "note" TEXT,
    "answeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealOfferAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealOfferAnswer_dealId_idx" ON "DealOfferAnswer"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "DealOfferAnswer_dealId_rowId_key" ON "DealOfferAnswer"("dealId", "rowId");

-- AddForeignKey
ALTER TABLE "DealOfferAnswer" ADD CONSTRAINT "DealOfferAnswer_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
