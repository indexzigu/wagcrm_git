-- CreateEnum
CREATE TYPE "ClaimSeverity" AS ENUM ('BLOCK', 'WARN');

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('APPROVED_CLAIM', 'BANNED_PHRASE', 'REQUIRED_DISCLOSURE');

-- CreateEnum
CREATE TYPE "ClaimEvidenceType" AS ENUM ('MEASURED', 'USER_PROVIDED', 'NEEDS_SOURCE');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "category" TEXT;

-- CreateTable
CREATE TABLE "BannedPhraseRule" (
    "id" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "pattern" TEXT,
    "category" TEXT,
    "severity" "ClaimSeverity" NOT NULL DEFAULT 'WARN',
    "legalBasis" TEXT NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BannedPhraseRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealClaim" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "kind" "ClaimKind" NOT NULL,
    "text" TEXT NOT NULL,
    "evidence" TEXT,
    "evidenceType" "ClaimEvidenceType" NOT NULL DEFAULT 'NEEDS_SOURCE',
    "status" "ClaimStatus" NOT NULL DEFAULT 'PROPOSED',
    "reviewBy" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedNote" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BannedPhraseRule_active_category_idx" ON "BannedPhraseRule"("active", "category");

-- CreateIndex
CREATE INDEX "DealClaim_dealId_status_idx" ON "DealClaim"("dealId", "status");

-- CreateIndex
CREATE INDEX "DealClaim_status_reviewBy_idx" ON "DealClaim"("status", "reviewBy");

-- AddForeignKey
ALTER TABLE "DealClaim" ADD CONSTRAINT "DealClaim_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
