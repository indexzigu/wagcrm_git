-- 월정산 공급사 계산서 「확인함」(오너 승인 2026-10-15) — 기록한 계산서 합계가 단위 전액과 어긋나 「확인 필요」가
-- 뜬 단위를 오너가 원인을 보고 표시한다. 확인은 그 차이의 지문(이유 코드·기록 합계·전액)에만 묶여, 금액이 바뀌면
-- 저절로 효력을 잃는다(판정 src/lib/campaign-invoices.ts · 쓰기 src/services/campaignInvoiceService.ts).
--
-- 순수 additive 다: 신규 테이블 1개. 기존 SELECT 를 깨지 않고 착지 시점의 데이터 변화도 없다 — 행은 오너가
-- 「확인함」을 누를 때만 생긴다.
-- CreateTable
CREATE TABLE "CampaignInvoiceReviewAck" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "acknowledgedBy" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignInvoiceReviewAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignInvoiceReviewAck_campaignId_direction_key" ON "CampaignInvoiceReviewAck"("campaignId", "direction");

-- AddForeignKey
ALTER TABLE "CampaignInvoiceReviewAck" ADD CONSTRAINT "CampaignInvoiceReviewAck_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SalesCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- EnableRowLevelSecurity
-- P6 「New Table ⇒ New RLS」 — 정책 0개(anon·authenticated 전면 거부), Prisma `postgres` 롤은
-- 소유자라 우회하므로 앱 동작 무변화. `FORCE` 는 쓰지 않는다. 계약: `rls-coverage.contract.test.ts`.
ALTER TABLE "CampaignInvoiceReviewAck" ENABLE ROW LEVEL SECURITY;

-- 봇 워커(wag_agent_worker) 읽기 — get_tax_invoice_status 가 세무 보드를 만들 때 월정산 진행
-- (campaignInvoiceService.loadInvoiceProgress → evaluateUnits)이 이 표를 읽는다. 열지 않으면 그 동작이
-- DB_PERMISSION_DENIED 로 죽는다(20261014120000 이 CampaignInvoice 를 연 것과 같은 이유).
-- · 칸 단위로만 연다: id · campaignId · direction · fingerprint. 확인한 사람(acknowledgedBy)·시각은 닫는다 —
--   판정에는 지문만 쓰고(evaluateUnits 의 select 가 그 넷뿐이다) 누가는 오너 화면 풀이 전용이다.
-- · RLS 정책이 없으면 행이 0건으로 **조용히** 비어 확인이 봇에게만 안 보인다 — 정책을 함께 만든다.
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 NOTICE 만 남긴다.
--
-- 되돌리기(수동, 필요할 때만):
--   DROP POLICY IF EXISTS "wag_agent_worker_campaign_invoice_review_ack" ON "CampaignInvoiceReviewAck";
--   REVOKE ALL ON TABLE "CampaignInvoiceReviewAck" FROM wag_agent_worker;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE "CampaignInvoiceReviewAck" FROM wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id", "campaignId", "direction", "fingerprint") ON TABLE "CampaignInvoiceReviewAck" TO wag_agent_worker';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_campaign_invoice_review_ack" ON "CampaignInvoiceReviewAck"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_campaign_invoice_review_ack" ON "CampaignInvoiceReviewAck" FOR SELECT TO wag_agent_worker USING (true)';
  ELSE
    RAISE NOTICE 'wag_agent_worker absent: grants skipped';
  END IF;
END $$;
