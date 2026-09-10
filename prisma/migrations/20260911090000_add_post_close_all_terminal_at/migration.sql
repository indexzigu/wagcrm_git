-- 사후 취소·교환 확인의 「전 주문 종결 최초 관측 시각」 칸.
-- 이 시각 +10일에 확인을 멈춘다(판정 SSOT: src/lib/order-converter/post-close-check-window.ts).
-- 기존 행은 전부 NULL 이라, 배포 후 첫 실행에서 창 안 캠페인의 종결 여부를 한 번 관측해 채운다.
-- AlterTable
ALTER TABLE "OrderCampaign" ADD COLUMN     "cachedPostCloseAllTerminalAt" TIMESTAMP(3);
