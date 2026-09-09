-- 사후 취소 계산의 「확정 시각」 칸.
-- 기존 두 칸(cachedPostCloseCancelQuantity/Revenue)이 Int? @default(0) 이라 값만으로는
-- "계산했는데 취소가 0" 과 "계산된 적이 없다" 가 구분되지 않았다. 이 칸이 그 구분을 맡는다.
-- 기존 행은 전부 NULL 이므로, 배포 후 첫 실행에서 창 안의 락 캠페인이 1회 마지막 계산을
-- 하고 확정된다(의도된 따라잡기).
-- AlterTable
ALTER TABLE "OrderCampaign" ADD COLUMN     "cachedPostCloseCancelFinalizedAt" TIMESTAMP(3);
