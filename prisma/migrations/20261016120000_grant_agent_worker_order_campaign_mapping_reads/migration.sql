-- agent worker 의 새 읽기 동작 get_order_campaign_mappings(src/lib/agent-worker/order-campaign-mappings.ts)가
-- 읽는 두 표에 **칸 단위 SELECT 만** 연다. 스키마 변경은 없다. 봇이 상품 매핑 변경 기안을 올리기 전에
-- 주문캠페인과 그 매핑의 지금 값을 보려는 것이다(쓰기는 기존 결재 파이프라인이 앱 권한으로 한다).
--
-- 이미 열려 있어 손대지 않는 표: SalesCampaign(20260902080000_add_agent_job_queue) — 판매캠페인 id 를
--   orderCampaignId 로 찾는 데 쓴다.
--
-- 표마다 여는 칸:
-- · "OrderCampaign" — id · name · sellerName · isActive · startDate · endDate. 수신·참조 이메일(toEmail ·
--   ccEmail), 썸네일, 네이버 상품 id, 판매 집계·정산 캐시 칸은 닫혀 있다. 그래서 실행기의 Prisma 호출은
--   전부 명시 select 다 — 기본 select 는 닫힌 칸에 닿아 권한 거부로 끝난다.
-- · "ProductMapping" — id · campaignId · productName · optionName · brandCode · price · campaignDealId.
--   campaignDealId 는 실행기가 값 대신 「딜에 연결됨」 여부로만 내보낸다. createdAt 은 닫혀 있다.
--
-- 행 범위: 두 표 모두 USING (true) — 봇은 이름으로 아무 주문캠페인이나 찾을 수 있어야 한다.
-- · RLS(20260715120000_enable_rls_public_tables 에서 ENABLE)는 정책이 없으면 행이 0건으로 **조용히**
--   비므로 GRANT 와 정책을 짝으로 만든다. 다시 돌려도 되게 DROP POLICY IF EXISTS 를 앞에 둔다.
-- · 먼저 REVOKE ALL 로 이 role 의 기존 권한(표·칸 단위 모두)을 걷어 낸다 — 손으로 표 단위 SELECT 를 줘 둔
--   DB 에서도 결과가 아래 목록과 정확히 같아지게 하려는 것이다(20261014120000 과 같은 형태).
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 NOTICE 만 남긴다.
--
-- 되돌리기(수동, 필요할 때만 — Prisma 는 down 마이그레이션을 돌리지 않는다):
--   DROP POLICY IF EXISTS "wag_agent_worker_order_campaign" ON "OrderCampaign";
--   DROP POLICY IF EXISTS "wag_agent_worker_product_mapping" ON "ProductMapping";
--   REVOKE ALL ON TABLE "OrderCampaign", "ProductMapping" FROM wag_agent_worker;
--   (워커는 get_order_campaign_mappings 에서 DB_PERMISSION_DENIED 로 끝나고 다른 동작은 영향이 없다.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE "OrderCampaign", "ProductMapping" FROM wag_agent_worker';

    EXECUTE 'GRANT SELECT ("id","name","sellerName","isActive","startDate","endDate") ON TABLE "OrderCampaign" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id","campaignId","productName","optionName","brandCode","price","campaignDealId") ON TABLE "ProductMapping" TO wag_agent_worker';

    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_order_campaign" ON "OrderCampaign"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_order_campaign" ON "OrderCampaign" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_product_mapping" ON "ProductMapping"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_product_mapping" ON "ProductMapping" FOR SELECT TO wag_agent_worker USING (true)';
  ELSE
    RAISE NOTICE 'wag_agent_worker absent: grants skipped';
  END IF;
END $$;
