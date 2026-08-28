-- 죽은 정산 금액 컬럼 제거.
--
-- 이 2개 컬럼은 이름이 「정산 입금액/지급액」이라 대금 표시의 정본처럼 보였고 실제로
-- 캘린더 3표면·대시보드·지연정산 대조·AI 정산 확정 게이트가 전부 이 값을 읽었다.
-- 그런데 **채울 경로가 처음부터 없었다** — UI 입력란 0곳, PATCH 검증 스키마에도 없어
-- API 로도 못 썼다. 그 결과 전 소비처가 조용히 「미정」을 표시했고(크래시가 없어 오래
-- 몰랐다), AI 정산 확정 게이트는 100% 닫힌 채였다(#477).
--
-- 대금 금액의 정본은 채널별 근거식으로 옮겼다(#472 → #474):
--   셀러 지급 = actualPayoutAmount ?? sellerExpense · 브랜드몰 입금 = settlementSales
--   셀러몰 입금 = actualSales - sellerExpense · 공급사 지급 = 캠페인 단위 확정 불가(미정)
-- 정본 서술은 tax-filing-board.ts 의 MONEY_SLOT_DISPLAY_AMOUNT 주석.
--
-- 드롭 전 프로덕션 실측(2026-08-26): SalesCampaign 108행, 두 컬럼 모두 값 있는 행 **0건**.
-- 정산이 끝난 COMPLETED 68건조차 비어 있어 「아직 입력 안 함」이 아님을 확인했다.
ALTER TABLE "SalesCampaign" DROP COLUMN "settlementDeposit",
DROP COLUMN "settlementPayout";
