-- 수동 정산 기준액(판매대행비를 계산할 때 곱하는 금액).
-- NULL = 자동(기존 동작 그대로), 숫자(0 포함) = 운영자가 입력한 값 그대로 기준액으로 쓴다.
-- 우선순위·요율 자격 판정 SSOT: src/lib/campaign-financials.ts 의 resolveSellerFee ·
-- resolveSellerFeeBasisEligibility. 기존 행은 NULL 이라 동작 변화가 없다(additive).

-- AlterTable
ALTER TABLE "SalesCampaign" ADD COLUMN     "sellerFeeBasisOverride" DECIMAL(65,30);
