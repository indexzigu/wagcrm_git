-- 자동 작업 사고 장부 알림 표시(크론 자가 복구 2단계) — CronIncident 에 알림·요약·억제 시각 칸 4개.
--
-- 순수 additive 다: nullable 칸 4개. 기존 SELECT 를 깨지 않고 착지 시점의 데이터 변화도 없다 —
-- 값은 알림을 보낼 때부터 쌓인다. 기존 표라 RLS 는 20261018120000 이 이미 켜 두었다(정책 0개 유지).
-- 봇 워커(wag_agent_worker) 권한은 여전히 주지 않는다.
-- AlterTable
ALTER TABLE "CronIncident" ADD COLUMN     "alertedAt" TIMESTAMP(3),
ADD COLUMN     "digestedAt" TIMESTAMP(3),
ADD COLUMN     "recoveryAlertedAt" TIMESTAMP(3),
ADD COLUMN     "suppressedAt" TIMESTAMP(3);
