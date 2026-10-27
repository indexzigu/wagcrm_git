-- AlterTable
ALTER TABLE "ActionProposal" ADD COLUMN     "ownerNotifiedAt" TIMESTAMP(3);

-- 도입 시점에 이미 결재 대기 중이던 기안은 알림을 보낸 것으로 친다 — 첫 발송 회차가 묵은 기안을 한꺼번에
-- 텔레그램으로 쏟지 않게. 배포 뒤 새로 대기에 오른 기안만 알린다(src/app/api/cron/approval-outbox/route.ts).
UPDATE "ActionProposal" SET "ownerNotifiedAt" = CURRENT_TIMESTAMP WHERE "status" = 'PENDING_APPROVAL' AND "ownerNotifiedAt" IS NULL;
