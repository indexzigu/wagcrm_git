-- CreateTable
CREATE TABLE "DealGuideDraft" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CONTENT_GUIDE',
    "body" TEXT NOT NULL,
    "gateVerdict" TEXT NOT NULL,
    "claimIds" TEXT,
    "proofCardIncluded" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "referenceCount" INTEGER NOT NULL DEFAULT 0,
    "vocCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealGuideDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealGuideDraft_dealId_kind_key" ON "DealGuideDraft"("dealId", "kind");

-- AddForeignKey
ALTER TABLE "DealGuideDraft" ADD CONSTRAINT "DealGuideDraft_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」: public 스키마에 테이블을 추가하는 마이그레이션은 같은 PR 에서
-- RLS 를 켠다. 정책은 만들지 않는다 — 0개면 anon·authenticated 전면 거부이고, Prisma 가 쓰는
-- `postgres` 롤은 소유자라 우회하므로 **앱 동작 무변화**다. `FORCE` 는 쓰지 않는다(소유자까지
-- 대상이 되어 Prisma 경로가 깨진다). 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "DealGuideDraft" ENABLE ROW LEVEL SECURITY;
