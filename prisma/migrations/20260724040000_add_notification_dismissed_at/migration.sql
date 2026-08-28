-- 상태형 알림 스누즈 앵커: 운영자가 X로 해제한 시각.
-- createdAt 기준 스누즈는 "오래 방치 후 해제"에서 스누즈가 0이 되는 결함이 있어
-- 해제 시점 기준으로 교정한다. 기존 행은 NULL(스누즈 미적용 = 조건 지속 시 재부상).
ALTER TABLE "Notification" ADD COLUMN "dismissedAt" TIMESTAMP(3);
