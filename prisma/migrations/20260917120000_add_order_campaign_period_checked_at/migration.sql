-- 스토어(네이버) 판매기간을 마지막으로 확인한 시각.
-- 종료가 아직 먼 활성 주문캠페인은 이 값으로 재확인 간격을 잰다(판정 SSOT:
-- src/lib/order-converter/mapping-service.ts 의 shouldResyncCampaignPeriod ·
-- usesIdlePeriodCheckInterval). 기존 행은 NULL = "확인 기록 없음"이라 다음 조회에서 한 번 물어본다.

-- AlterTable
ALTER TABLE "OrderCampaign" ADD COLUMN     "periodCheckedAt" TIMESTAMP(3);
