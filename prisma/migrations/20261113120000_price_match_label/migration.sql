-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "monitorBrandAliases" TEXT;

-- CreateTable
CREATE TABLE "PriceMatchLabel" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "urlKey" TEXT,
    "label" TEXT NOT NULL,
    "channel" TEXT,
    "mall" TEXT,
    "productName" TEXT NOT NULL,
    "url" TEXT,
    "systemSaidSame" BOOLEAN NOT NULL,
    "cause" TEXT,
    "searchQuery" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceMatchLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceMatchLabel_dealId_idx" ON "PriceMatchLabel"("dealId");

-- CreateIndex
CREATE INDEX "PriceMatchLabel_createdAt_idx" ON "PriceMatchLabel"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PriceMatchLabel_dealId_nameKey_key" ON "PriceMatchLabel"("dealId", "nameKey");

-- AddForeignKey
ALTER TABLE "PriceMatchLabel" ADD CONSTRAINT "PriceMatchLabel_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "PriceMatchLabel" ENABLE ROW LEVEL SECURITY;
