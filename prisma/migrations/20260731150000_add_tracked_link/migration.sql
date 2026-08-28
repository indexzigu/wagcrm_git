-- 유입추적 단축링크 (go.ygrd.kr) — TrackedLink / LinkClick
--
-- 쓰기 주체가 하나씩이라 두 테이블 사이에 경합이 없다:
--   TrackedLink = wag-crm(Prisma) 전용 쓰기 · Worker 는 읽기만
--   LinkClick   = Cloudflare Worker(PostgREST service_role) 전용 쓰기 · wag-crm 은 읽기만
--
-- ⚠️ "LinkClick"."id" 에 DB default 를 두지 않는 것은 의도다. Prisma 의 @default(cuid()) 는
-- 앱 레벨 기본값이라 어차피 DDL 에 실리지 않으며, Worker 가 crypto.randomUUID() 로 값을
-- 채워 보낸다. 여기에 gen_random_uuid() 같은 DB default 를 추가하면 schema.prisma 와
-- 어긋나 Migration Guard(migrate diff)가 드리프트로 실패한다.

-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "baseUrl" TEXT,
    "label" TEXT,
    "salesCampaignId" TEXT,
    "sellerId" TEXT,
    "dealId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkClick" (
    "id" TEXT NOT NULL,
    "trackedLinkId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "subId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "visitorHash" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "refererHost" TEXT,
    "country" TEXT,
    "city" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_code_key" ON "TrackedLink"("code");

-- CreateIndex
CREATE INDEX "TrackedLink_salesCampaignId_idx" ON "TrackedLink"("salesCampaignId");

-- CreateIndex
CREATE INDEX "TrackedLink_sellerId_idx" ON "TrackedLink"("sellerId");

-- CreateIndex
CREATE INDEX "TrackedLink_dealId_idx" ON "TrackedLink"("dealId");

-- CreateIndex
CREATE INDEX "TrackedLink_isActive_idx" ON "TrackedLink"("isActive");

-- CreateIndex
CREATE INDEX "LinkClick_trackedLinkId_occurredAt_idx" ON "LinkClick"("trackedLinkId", "occurredAt");

-- CreateIndex
CREATE INDEX "LinkClick_code_occurredAt_idx" ON "LinkClick"("code", "occurredAt");

-- CreateIndex
CREATE INDEX "LinkClick_code_subId_idx" ON "LinkClick"("code", "subId");

-- CreateIndex
CREATE INDEX "LinkClick_occurredAt_idx" ON "LinkClick"("occurredAt");

-- CreateIndex
CREATE INDEX "LinkClick_visitorHash_idx" ON "LinkClick"("visitorHash");

-- CreateIndex
CREATE INDEX "LinkClick_isBot_idx" ON "LinkClick"("isBot");

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_salesCampaignId_fkey" FOREIGN KEY ("salesCampaignId") REFERENCES "SalesCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkClick" ADD CONSTRAINT "LinkClick_trackedLinkId_fkey" FOREIGN KEY ("trackedLinkId") REFERENCES "TrackedLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: 새 public 테이블은 같은 마이그레이션에서 RLS 를 켠다(docs/agents/deployment.md
-- "New Table ⇒ New RLS", 계약 테스트 src/lib/__tests__/rls-coverage.contract.test.ts).
--
-- 이 두 테이블은 특히 중요하다 — 레포가 public 이고 Supabase anon key 도 공개 표면에
-- 나가 있다. RLS 없이 두면 anon key 하나로 /rest/v1/LinkClick 을 통째로 긁어 셀러별
-- 유입 성과를 가져갈 수 있다(P0 Seller-Facing Data Exposure).
--
-- 정책은 하나도 만들지 않는다 → anon·authenticated 전면 거부. Worker 의 service_role 은
-- RLS 를 우회하고, Prisma 는 테이블 소유자(postgres)로 접속하므로 앱 동작은 변하지 않는다.
-- FORCE 는 쓰지 않는다(소유자까지 RLS 대상이 되어 Prisma 경로가 깨진다).
ALTER TABLE "TrackedLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LinkClick" ENABLE ROW LEVEL SECURITY;
