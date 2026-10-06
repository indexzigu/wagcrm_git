-- 발주서 자동 준비 스위치(발주 자동화 2단계) — 캠페인별 켜기/끄기, 기본 꺼짐.
-- 판정 SSOT: src/lib/order-converter/prepared-po.ts. 기존 행은 전부 꺼짐으로 시작한다(동작 무변화).
-- AlterTable
ALTER TABLE "OrderCampaign" ADD COLUMN     "autoPrepEnabled" BOOLEAN NOT NULL DEFAULT false;
