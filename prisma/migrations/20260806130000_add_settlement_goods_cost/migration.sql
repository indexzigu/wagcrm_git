-- 수기 물품대금(그 캠페인 앞으로 온 매입 계산서의 VAT 포함 합계).
-- 세무 대조 전용 — 손익·원가 소비 금지(expected-receivables-scope.contract.test.ts 가 강제).
-- settlementSupplyCost(공급가액 = 매출÷1.1)와 다른 숫자다 — 재사용하면 어휘가 충돌한다.
ALTER TABLE "SalesCampaign" ADD COLUMN "settlementGoodsCost" DECIMAL(65,30);
