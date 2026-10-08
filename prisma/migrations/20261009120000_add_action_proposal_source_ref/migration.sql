-- 기안 출처(sourceRef). 브리지가 올린 기안에 슬랙 위치 { slack: { channelId, threadTs, messageTs, rid } }
-- 를 싣는다 — 모양 정본은 src/lib/agent-worker/contracts.ts 의 AgentJobSlackOriginSchema 이고,
-- 값을 쓰는 곳은 agent worker 실행기(executor.ts createActionProposal) 하나다.
-- additive · nullable · 백필 없음: 기존 행과 출처 없는 기안은 NULL 그대로다.
-- 권한: wag_agent_worker 의 ActionProposal 권한은 **테이블 단위** GRANT SELECT, INSERT
-- (20260902080000_add_agent_job_queue) 라 새 컬럼에 별도 GRANT 가 필요 없다(컬럼 단위였다면 필요).

-- AlterTable
ALTER TABLE "ActionProposal" ADD COLUMN     "sourceRef" JSONB;
