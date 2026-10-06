-- 송장 회신 메일 감지 기록(크론 scan-invoice-replies, src/lib/order-converter/invoice-reply-scan.ts).
-- 감지만 한다 — 「처리됨」 칸은 두지 않고 화면이 배송대기 상태에서 파생한다(invoice-reply-status.ts).
-- CreateTable
CREATE TABLE "InvoiceReplyDetection" (
    "id" TEXT NOT NULL,
    "orderCampaignId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "uid" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "parsedTrackingCount" INTEGER NOT NULL DEFAULT 0,
    "trackingOrderKeys" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceReplyDetection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceReplyDetection_orderCampaignId_receivedAt_idx" ON "InvoiceReplyDetection"("orderCampaignId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceReplyDetection_orderCampaignId_messageId_key" ON "InvoiceReplyDetection"("orderCampaignId", "messageId");

-- AddForeignKey
ALTER TABLE "InvoiceReplyDetection" ADD CONSTRAINT "InvoiceReplyDetection_orderCampaignId_fkey" FOREIGN KEY ("orderCampaignId") REFERENCES "OrderCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- New Table ⇒ New RLS(docs/agents/deployment.md): 정책 없이 켠다 — anon·authenticated 전면 거부,
-- Prisma 가 쓰는 소유자 롤은 우회하므로 앱 동작 무변화. FORCE 는 쓰지 않는다.
ALTER TABLE "InvoiceReplyDetection" ENABLE ROW LEVEL SECURITY;
