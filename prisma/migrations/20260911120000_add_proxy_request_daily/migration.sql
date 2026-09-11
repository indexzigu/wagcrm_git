-- 프록시(Fixie) 요청 수의 경로별 일 집계(src/lib/order-converter/proxy-usage.ts).
-- CreateTable
CREATE TABLE "ProxyRequestDaily" (
    "id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyRequestDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProxyRequestDaily_day_idx" ON "ProxyRequestDaily"("day");

-- CreateIndex
CREATE UNIQUE INDEX "ProxyRequestDaily_day_source_target_key" ON "ProxyRequestDaily"("day", "source", "target");

ALTER TABLE "ProxyRequestDaily" ENABLE ROW LEVEL SECURITY;
