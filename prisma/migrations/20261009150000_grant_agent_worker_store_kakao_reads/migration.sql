-- agent worker 의 새 읽기 동작(get_store_status · list_work_record_rooms · get_work_records,
-- src/lib/agent-worker/executor.ts)이 읽는 카톡 두 표에 **SELECT 만** 연다. 스키마 변경은 없다.
--
-- · NaverOrderSnapshot 은 20260902080000_add_agent_job_queue 가 이미 열었다(get_store_status 는 그것만 읽는다).
-- · 칸 단위 GRANT 다(그 마이그레이션의 표 단위와 다르다). 이 두 표에는 워커가 내보내면 안 되는 칸이 있어서다:
--   ChatRoomMapping."roomName"(1:1 방은 대개 상대 이름) · WorkRecord."ingestedBy"(로그인 계정 id)·
--   "summary"·"actionItems"·"sourceHash". 실행기는 허용 칸만 select 하고(executor.ts), 칸을 하나 더 읽으려 하면
--   여기서 permission denied 로 멈춘다 — 실수가 조용한 유출이 아니라 시끄러운 실패가 되게 하려는 것이다.
-- · RLS(20260715120000 에서 ENABLE)는 정책이 없으면 행이 0건으로 **조용히** 비므로 정책을 함께 만든다.
--   두 정책 모두 화이트리스트(카톡 자동 수집 중인 방 = 러너 게이트 `listWithCursors` 와 같은 조건)로 좁힌다 —
--   실행기의 화이트리스트 검사가 빠져도 DB 가 같은 선을 지킨다.
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 아무것도 하지 않는다 —
--   원 GRANT 블록과 같은 `IF EXISTS` 형태다.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'GRANT SELECT ("id", "source", "roomKey", "roomType", "entityType", "entityId", "collectorType", "excluded", "campaignId", "lastSyncedAt") ON TABLE "ChatRoomMapping" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id", "source", "roomKey", "sender", "sentAt", "rawText", "isMasked", "entityType", "entityId", "campaignId") ON TABLE "WorkRecord" TO wag_agent_worker';

    EXECUTE 'CREATE POLICY "wag_agent_worker_chat_room_mapping" ON "ChatRoomMapping" FOR SELECT TO wag_agent_worker '
         || 'USING ("source" = ''KAKAO'' AND "collectorType" = ''KATOK_AUTO'' AND "excluded" = false)';
    EXECUTE 'CREATE POLICY "wag_agent_worker_work_record" ON "WorkRecord" FOR SELECT TO wag_agent_worker '
         || 'USING ("source" = ''KAKAO'' AND EXISTS ('
         || 'SELECT 1 FROM "ChatRoomMapping" m WHERE m."source" = ''KAKAO'' AND m."roomKey" = "WorkRecord"."roomKey" '
         || 'AND m."collectorType" = ''KATOK_AUTO'' AND m."excluded" = false))';
  END IF;
END $$;
