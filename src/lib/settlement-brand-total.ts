/**
 * 거래처(브랜드사)와 주고받을 **캠페인 1건의 정산 총액** 판정 SSOT — 순수 함수.
 *
 * ## 왜 이 모듈이 생겼나
 * 이 판정은 원래 재무 카드(`campaign-side-panel.tsx`) 안에 손으로 박혀 있었고, 소비처가
 * 하나뿐인 동안에는 그것으로 충분했다. 정산 목록의 선택 바가 **같은 금액을 여러 건 합산해**
 * 보여주게 되면서 소비처가 둘이 됐다 — 화면이 각자 계산하면 같은 캠페인이 두 자리에서
 * 다른 금액을 말한다(이 레포가 `settlement-statement`·`settlement-selection-summary`
 * 에서 이미 두 번 겪은 실패다).
 *
 * ## 부호 규약 — 양수 = 우리가 받을 돈, 음수 = 우리가 지급할 돈
 * 방향을 채널로 고정하지 않고 **금액의 부호**에서 파생하는 것이 이 모듈의 핵심 계약이다.
 * 부가 항목(광고비·반품배송비 등)이 채널의 기본 방향을 뒤집을 수 있어서다 — 우리몰인데
 * 브랜드사에 청구할 광고비가 물품대금보다 크면 방향이 반대가 된다. 채널로만 정하면
 * 「지급할 총액 +500,000원」 같은 거짓말이 나온다.
 * 부호가 없는 `0` 에서만 채널이 정한 기본 방향(`resolveCampaignMoneySlots` 의 SUPPLIER 슬롯)을 쓴다.
 */

import { resolveGoodsCost, resolveGoodsCostContribution } from "./goods-cost";
import { sumBrandItems, type SettlementItemInput } from "./settlement-items";
import { resolveCampaignMoneySlots, resolveTaxFilingChannelGroup } from "./tax-filing-board";

export interface BrandSettlementTotalInput {
  salesChannel?: string | null;
  actualSales?: number | null;
  settlementSales?: number | null;
  settlementGoodsCost?: number | null;
  /**
   * 부가 항목. ⚠️ **빈 배열과 미조회를 구분하지 못한다** — 이 함수는 넘어온 대로 더할 뿐이다.
   * 목록 페이로드가 이 필드를 안 실어 보내면 광고비·반품배송비가 조용히 빠진 금액이 나온다.
   * 그래서 목록 조회(`dashboard-data.ts`)와 목록 API(`campaignService.getCampaignsList`)가
   * **둘 다** 이 관계를 include 하며, 그 짝은 계약 테스트가 고정한다.
   */
  settlementItems?: readonly SettlementItemInput[] | null;
}

export interface BrandSettlementTotal {
  /** 부호 있는 금액. 양수 = 받을 돈 · 음수 = 지급할 돈. */
  amount: number;
  /** 라벨·색이 쓰는 방향 판정. `amount === 0` 이면 채널 기본 방향을 따른다. */
  weReceive: boolean;
  /** 물품대금이 관측값이 아니라 공식 추정이면 참 — 화면이 그 사실을 숨기지 않게 한다. */
  isEstimated: boolean;
}

export function resolveBrandSettlementTotal(
  input: BrandSettlementTotalInput,
): BrandSettlementTotal {
  const salesChannel = input.salesChannel ?? "";
  const grossSales = Number(input.actualSales ?? 0);
  const grossCommission = Number(input.settlementSales ?? 0);
  const channelGroup = resolveTaxFilingChannelGroup(salesChannel);

  // ⛔ 물품대금 3-상태 판정을 손으로 다시 쓰지 말 것 — 공유 SSOT 를 쓴다. 재무 카드가
  //    한때 판정을 재구현했다가 `0`(합산 이관 마커)을 `null`(미입력)과 같이 취급해,
  //    항목 행은 「합산 이관」이라는데 총액은 공식 추정치를 확정값처럼 보여준 적이 있다.
  const goodsCost = resolveGoodsCost({
    manualGoodsCost: input.settlementGoodsCost,
    actualSales: grossSales,
    settlementSales: grossCommission,
  });
  const goodsCostForTotal = resolveGoodsCostContribution(goodsCost);

  // 우리몰·셀러몰은 물품대금을 지급하는 쪽이고 브랜드몰은 영업수익을 받는 쪽이다.
  const baseAmount = channelGroup === "BRAND_MALL" ? grossCommission : -goodsCostForTotal;
  const amount = baseAmount + sumBrandItems(input.settlementItems ?? []);

  // 공식 추정이 섞인 총액이면 그 사실을 숨기지 않는다. 판정은 위 SSOT 를 따른다 —
  // `== null` 로 다시 유도하면 합산 이관(0)이 "확정값"으로 분류돼 힌트가 사라진다.
  const isEstimated = channelGroup !== "BRAND_MALL" && goodsCost.kind === "FORMULA";

  const channelPaysUs =
    resolveCampaignMoneySlots(salesChannel).find((slot) => slot.counterpart === "SUPPLIER")
      ?.kind === "DEPOSIT";

  return {
    amount,
    weReceive: amount === 0 ? channelPaysUs : amount > 0,
    isEstimated,
  };
}
