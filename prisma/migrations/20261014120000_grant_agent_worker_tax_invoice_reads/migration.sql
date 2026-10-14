-- agent worker 의 새 읽기 동작 get_tax_invoice_status(src/lib/agent-worker/executor.ts)가 읽는 네 표에
-- **SELECT 만** 연다. 스키마 변경은 없다. 그 동작은 오너 화면(정산 「세무 처리」 보드)과 같은 함수
-- (src/lib/tax-invoice-board-data.ts)로 보드를 만들므로, 아래는 그 함수가 실제로 읽는 표·칸이다.
--
-- 이미 열려 있어 손대지 않는 표: SalesCampaign · Deal · Partner · Seller · CampaignGroup
--   (20260902080000_add_agent_job_queue). 보드 쿼리는 일부러 CampaignDeal · SellersHistory ·
--   PartnerContact 를 읽지 않게 좁혀 두었다(보드 판정이 안 쓰는 관계) — 그래서 그 셋은 계속 닫혀 있다.
--
-- 표마다 왜 필요한가:
-- · "CampaignSettlementItem"(표 단위) — 부가 항목이 보드 금액을 움직인다. 빠지면 금액이 오류 없이
--   틀린다(tax-filing-board route 주석). 실행기는 행을 내보내지 않고 보드 금액만 싣는다.
-- · "CampaignInvoice"(표 단위) — 월정산 공급사 칸의 달별 진행(campaignInvoiceService.loadInvoiceProgress
--   가 행 전체를 읽는다). 승인번호·금액 칸이 있지만 실행기는 진행 수(n/m)만 싣는다.
-- · "ActivityLog"(칸 단위) — 보드의 「자동 확정됨」 목록. 읽는 칸만 연다(id · entityType · entityId ·
--   type · fieldName · newValue · content · createdAt). previousValue · actor 는 닫혀 있다. content 에는
--   승인번호·합계 문장이 들어 있어 실행기가 내보내지 않는다(확정 묶음 키로만 쓴다).
-- · "SystemTaskLog"(칸 단위) — 발행 자동 확정 크론의 마지막 실행. id · jobKey · status · details ·
--   createdAt 만 연다. message(오류 문구 — 접속 대상이 섞일 수 있다)는 닫혀 있다.
--
-- 행 범위: 두 로그 표는 실행기가 이미 where 로 좁히지만(app-side), 같은 선을 RLS 정책으로도 긋는다 —
--   ActivityLog 는 캠페인의 발행 자동 확정 로그(type 이 TAX_INVOICE_AUTO_CONFIRM 으로 시작)만,
--   SystemTaskLog 는 jobKey = 'tax-invoice-issue-confirm' 만 보인다. 실행기의 where 가 빠져도 DB 가 막는다.
--   ⚠️ LIKE 대신 starts_with 를 쓴다 — LIKE 의 '_' 는 아무 글자와 맞아 선이 넓어진다.
--   다른 두 표는 보드가 정산 단계 캠페인 전부를 보므로 USING (true) 다.
-- · RLS(20260715120000 · 각 표 신설 마이그레이션에서 ENABLE)는 정책이 없으면 행이 0건으로 **조용히**
--   비므로 정책을 함께 만든다. 다시 돌려도 되게 DROP POLICY IF EXISTS 를 앞에 둔다.
-- · 먼저 REVOKE ALL 로 이 role 의 기존 권한(표·칸 단위 모두)을 걷어 낸다 — 손으로 표 단위 SELECT 를 줘 둔
--   DB 에서도 결과가 아래 목록과 정확히 같아지게 하려는 것이다(20261009150000 과 같은 형태).
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 NOTICE 만 남긴다.
--
-- 되돌리기(수동, 필요할 때만 — Prisma 는 down 마이그레이션을 돌리지 않는다):
--   DROP POLICY IF EXISTS "wag_agent_worker_campaign_settlement_item" ON "CampaignSettlementItem";
--   DROP POLICY IF EXISTS "wag_agent_worker_campaign_invoice" ON "CampaignInvoice";
--   DROP POLICY IF EXISTS "wag_agent_worker_activity_log" ON "ActivityLog";
--   DROP POLICY IF EXISTS "wag_agent_worker_system_task_log" ON "SystemTaskLog";
--   REVOKE ALL ON TABLE "CampaignSettlementItem", "CampaignInvoice", "ActivityLog", "SystemTaskLog" FROM wag_agent_worker;
--   (워커는 get_tax_invoice_status 에서 DB_PERMISSION_DENIED 로 끝나고 다른 동작은 영향이 없다.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE "CampaignSettlementItem", "CampaignInvoice", "ActivityLog", "SystemTaskLog" FROM wag_agent_worker';

    EXECUTE 'GRANT SELECT ON TABLE "CampaignSettlementItem", "CampaignInvoice" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id", "entityType", "entityId", "type", "fieldName", "newValue", "content", "createdAt") ON TABLE "ActivityLog" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id", "jobKey", "status", "details", "createdAt") ON TABLE "SystemTaskLog" TO wag_agent_worker';

    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_campaign_settlement_item" ON "CampaignSettlementItem"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_campaign_settlement_item" ON "CampaignSettlementItem" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_campaign_invoice" ON "CampaignInvoice"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_campaign_invoice" ON "CampaignInvoice" FOR SELECT TO wag_agent_worker USING (true)';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_activity_log" ON "ActivityLog"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_activity_log" ON "ActivityLog" FOR SELECT TO wag_agent_worker '
         || 'USING ("entityType" = ''CAMPAIGN'' AND starts_with("type", ''TAX_INVOICE_AUTO_CONFIRM''))';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_system_task_log" ON "SystemTaskLog"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_system_task_log" ON "SystemTaskLog" FOR SELECT TO wag_agent_worker '
         || 'USING ("jobKey" = ''tax-invoice-issue-confirm'')';
  ELSE
    RAISE NOTICE 'wag_agent_worker absent: grants skipped';
  END IF;
END $$;
