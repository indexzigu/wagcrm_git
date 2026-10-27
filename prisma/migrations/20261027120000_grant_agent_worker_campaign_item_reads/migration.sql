-- agent worker 의 새 읽기 동작 get_campaign_items(src/lib/agent-worker/campaign-items.ts)와 판매캠페인 품목 추가 기안
-- (add_campaign_items)의 기안 시점 확인(src/lib/agent-worker/executor.ts campaignItemsSubjectCheck)이 읽는 판매캠페인
-- 품목 표에 **칸 단위 SELECT 만** 연다. 스키마 변경은 없다. 봇이 품목 추가 기안을 올리기 전에 어떤 하위품목이 이미
-- 품목에 있는지 보려는 것이다(쓰기는 기존 결재 파이프라인이 앱 권한으로 한다).
--
-- 이미 열려 있어 손대지 않는 표: SalesCampaign · Deal · Seller(20260902080000_add_agent_job_queue).
--
-- 여는 칸: "CampaignDeal" — id · campaignId · dealId. 수량(orderCount) · 실매출 · 수수료율 · 셀러마진율 · 원가 ·
--   판매가 칸은 닫혀 있다(원가·마진이 슬랙·클라우드 모델로 나가지 않게). 그래서 실행기의 Prisma 호출은 전부 명시
--   select 다 — 기본 select 는 닫힌 칸에 닿아 권한 거부로 끝난다.
--
-- 행 범위: USING (true) — 봇은 아무 판매캠페인의 품목이나 볼 수 있어야 한다.
-- · RLS(20260715120000_enable_rls_public_tables 에서 ENABLE)는 정책이 없으면 행이 0건으로 **조용히** 비므로
--   GRANT 와 정책을 짝으로 만든다. 다시 돌려도 되게 DROP POLICY IF EXISTS 를 앞에 둔다.
-- · 먼저 REVOKE ALL 로 이 role 의 기존 권한(표·칸 단위 모두)을 걷어 낸다 — 손으로 표 단위 SELECT 를 줘 둔 DB 에서도
--   결과가 아래 목록과 정확히 같아지게 하려는 것이다(20261016120000 과 같은 형태).
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 NOTICE 만 남긴다.
--
-- 되돌리기(수동, 필요할 때만 — Prisma 는 down 마이그레이션을 돌리지 않는다):
--   DROP POLICY IF EXISTS "wag_agent_worker_campaign_deal" ON "CampaignDeal";
--   REVOKE ALL ON TABLE "CampaignDeal" FROM wag_agent_worker;
--   (워커는 get_campaign_items · add_campaign_items 기안에서 DB_PERMISSION_DENIED 로 끝나고 다른 동작은 영향이 없다.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE "CampaignDeal" FROM wag_agent_worker';

    EXECUTE 'GRANT SELECT ("id","campaignId","dealId") ON TABLE "CampaignDeal" TO wag_agent_worker';

    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_campaign_deal" ON "CampaignDeal"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_campaign_deal" ON "CampaignDeal" FOR SELECT TO wag_agent_worker USING (true)';
  ELSE
    RAISE NOTICE 'wag_agent_worker absent: grants skipped';
  END IF;
END $$;
