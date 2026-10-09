-- agent worker 의 새 읽기 동작(get_store_status · list_work_record_rooms · get_work_records,
-- src/lib/agent-worker/executor.ts)이 읽는 카톡 두 표에 **SELECT 만** 연다. 스키마 변경은 없다.
--
-- · NaverOrderSnapshot 은 20260902080000_add_agent_job_queue 가 이미 열었다(get_store_status 는 그것만 읽는다).
-- · 칸 단위 GRANT 다(그 마이그레이션의 표 단위와 다르다). 이 두 표에는 워커가 내보내면 안 되는 칸이 있어서다:
--   ChatRoomMapping."roomName"(1:1 방은 대개 상대 이름) · WorkRecord."ingestedBy"(로그인 계정 id)·
--   "summary"·"actionItems"·"sourceHash". 실행기는 허용 칸만 select 하고(executor.ts), 칸을 하나 더 읽으려 하면
--   여기서 permission denied 로 멈춘다(실행기는 이를 재시도 없는 DB_PERMISSION_DENIED 로 끝낸다) —
--   실수가 조용한 유출이 아니라 시끄러운 실패가 되게 하려는 것이다.
-- · 먼저 REVOKE ALL 로 두 표에 대한 이 role 의 기존 권한(표 단위·칸 단위 모두)을 걷어 낸다 — 누가 손으로
--   표 단위 SELECT 를 줘 둔 DB 에서도 결과가 아래 칸 목록과 정확히 같아지게 하려는 것이다.
-- · RLS(20260715120000 에서 ENABLE)는 정책이 없으면 행이 0건으로 **조용히** 비므로 정책을 함께 만든다.
--   두 정책 모두 화이트리스트(카톡 자동 수집 중인 방 = 러너 게이트 `listWithCursors` 와 같은 조건)로 좁힌다 —
--   실행기의 화이트리스트 검사가 빠져도 DB 가 같은 선을 지킨다. 같은 이름의 정책이 남아 있어도 다시 만들 수
--   있게 DROP POLICY IF EXISTS 를 앞에 둔다.
-- · INSERT·UPDATE·DELETE 는 주지 않는다. 역할이 없는 DB(로컬·CI shadow)에서는 NOTICE 만 남기고 아무것도
--   하지 않는다 — 원 GRANT 블록과 같은 `IF EXISTS` 형태다.
--
-- 되돌리기(수동, 필요할 때만 — Prisma 는 down 마이그레이션을 돌리지 않는다):
--   DROP POLICY IF EXISTS "wag_agent_worker_work_record" ON "WorkRecord";
--   DROP POLICY IF EXISTS "wag_agent_worker_chat_room_mapping" ON "ChatRoomMapping";
--   REVOKE ALL ON TABLE "ChatRoomMapping", "WorkRecord" FROM wag_agent_worker;
--   (이 세 줄로 이 마이그레이션 이전 상태 — 워커가 두 표를 전혀 못 읽는 상태 — 로 돌아간다.
--    워커는 해당 세 동작에서 DB_PERMISSION_DENIED 로 끝나고 다른 동작은 영향이 없다.)

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wag_agent_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE "ChatRoomMapping", "WorkRecord" FROM wag_agent_worker';

    EXECUTE 'GRANT SELECT ("id", "source", "roomKey", "roomType", "entityType", "entityId", "collectorType", "excluded", "campaignId", "lastSyncedAt") ON TABLE "ChatRoomMapping" TO wag_agent_worker';
    EXECUTE 'GRANT SELECT ("id", "source", "roomKey", "sender", "sentAt", "rawText", "isMasked", "entityType", "entityId", "campaignId") ON TABLE "WorkRecord" TO wag_agent_worker';

    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_chat_room_mapping" ON "ChatRoomMapping"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_chat_room_mapping" ON "ChatRoomMapping" FOR SELECT TO wag_agent_worker '
         || 'USING ("source" = ''KAKAO'' AND "collectorType" = ''KATOK_AUTO'' AND "excluded" = false)';
    EXECUTE 'DROP POLICY IF EXISTS "wag_agent_worker_work_record" ON "WorkRecord"';
    EXECUTE 'CREATE POLICY "wag_agent_worker_work_record" ON "WorkRecord" FOR SELECT TO wag_agent_worker '
         || 'USING ("source" = ''KAKAO'' AND EXISTS ('
         || 'SELECT 1 FROM "ChatRoomMapping" m WHERE m."source" = ''KAKAO'' AND m."roomKey" = "WorkRecord"."roomKey" '
         || 'AND m."collectorType" = ''KATOK_AUTO'' AND m."excluded" = false))';
  ELSE
    RAISE NOTICE 'wag_agent_worker absent: grants skipped';
  END IF;
END $$;
