/**
 * 정산 목록에서 **선택한 캠페인들**을 거래처별로 묶어 「보낼 돈 / 받을 돈」을 내는 SSOT.
 *
 * ## 왜 거래처 단위로 상계하나 (오너 확정 2026-08-28)
 * 같은 거래처와 이번 달에 A 캠페인은 지급, B 캠페인은 입금이 걸릴 수 있다. 실제 운영에서
 * 송금은 **거래처당 한 번**이므로 그 둘을 상계한 순액이 오너가 은행에서 쓸 숫자다.
 * 그래서 방향(보낼/받을) 판정은 캠페인이 아니라 **거래처 순액의 부호**로 한다.
 *
 * ## 금액의 정의는 여기서 만들지 않는다
 * 캠페인 1건의 금액은 `resolveBrandSettlementTotal`(SSOT)이 낸다 — 재무 카드의
 * 「브랜드사에 지급할/에서 받을 총액」과 **같은 값**이다. 이 모듈은 그것을 묶기만 한다.
 */

import {
  resolveBrandSettlementTotal,
  type BrandSettlementTotalInput,
} from "./settlement-brand-total";

/** 거래처 미연결 캠페인이 묶이는 자리 — `campaign-row.ts` 가 넣는 표기와 같은 문자열이다. */
export const PARTNER_UNLINKED_NAME = "거래처 없음";

export interface PartnerBreakdownInput extends BrandSettlementTotalInput {
  id: string;
  campaignName?: string | null;
  dealName?: string | null;
  partnerId?: string | null;
  partnerName?: string | null;
}

export interface PartnerBreakdownCampaign {
  campaignId: string;
  label: string;
  /** 부호 있는 금액. 양수 = 받을 돈 · 음수 = 지급할 돈. */
  amount: number;
  /** 물품대금이 관측값이 아니라 공식 추정이면 참. */
  estimated: boolean;
}

export interface PartnerBreakdownGroup {
  /** 그룹 식별자 — 거래처 id 가 없으면 이름으로 묶는다(미연결 캠페인이 한 덩어리가 된다). */
  key: string;
  partnerName: string;
  /** 소속 캠페인 금액의 합(상계된 순액). */
  amount: number;
  /** 금액이 0 이 아닌 캠페인만. 0 은 어느 방향에도 기여하지 않아 줄만 늘린다. */
  campaigns: PartnerBreakdownCampaign[];
  /** 소속 캠페인 중 하나라도 추정이면 참 — 순액도 그만큼 추정이다. */
  estimated: boolean;
}

export interface PartnerSettlementBreakdown {
  /** 우리가 보낼 돈의 합 — **양수**로 낸다(부호는 라벨과 색이 이미 말한다). */
  payable: number;
  /** 우리가 받을 돈의 합 — **양수**로 낸다. */
  receivable: number;
  /** 표시 순서: 보낼 돈 → 받을 돈 → 상계로 0 이 된 거래처. 각 구간은 금액 큰 순. */
  groups: PartnerBreakdownGroup[];
  /**
   * 합계에 공식 추정이 섞였는가 — **화면이 이 사실을 숨기면 안 된다.**
   * 재무 카드는 같은 판정을 「추정 포함」 힌트로 이미 노출한다(`campaign-side-panel`).
   * 여기서 떨어뜨리면 오너가 확정 금액과 추정 금액을 구분하지 못한 채 이체하게 된다
   * (교차 검증 지적 2026-08-28).
   */
  estimated: boolean;
}

export function buildPartnerSettlementBreakdown(
  campaigns: readonly PartnerBreakdownInput[],
): PartnerSettlementBreakdown {
  const byPartner = new Map<string, PartnerBreakdownGroup>();

  for (const campaign of campaigns) {
    const partnerName = campaign.partnerName?.trim() || PARTNER_UNLINKED_NAME;
    // id 를 우선 쓰되 없으면 이름으로 묶는다 — 이름만 같고 실체가 다른 거래처를 합치는
    // 위험보다, 미연결 건들이 제각각 한 줄씩 늘어서는 쪽이 화면에서 더 나쁘다.
    const key = campaign.partnerId?.trim() || `name:${partnerName}`;
    const { amount, isEstimated } = resolveBrandSettlementTotal(campaign);

    const group = byPartner.get(key) ?? {
      key,
      partnerName,
      amount: 0,
      campaigns: [],
      estimated: false,
    };
    group.amount += amount;
    if (amount !== 0) {
      // 추정 여부는 **기여한 캠페인**에서만 올린다 — 금액 0(합산 이관)인 건은 순액에
      // 아무것도 더하지 않으므로 그것 때문에 합계를 추정으로 표시하면 거짓 경고가 된다.
      group.estimated = group.estimated || isEstimated;
      group.campaigns.push({
        campaignId: campaign.id,
        label: campaign.campaignName?.trim() || campaign.dealName?.trim() || "이름 없는 캠페인",
        amount,
        estimated: isEstimated,
      });
    }
    byPartner.set(key, group);
  }

  const groups = [...byPartner.values()].filter(
    // 금액도 0 이고 기여한 캠페인도 없으면 보여줄 것이 없다. ⚠️ 순액만 0 인 그룹(지급·입금이
    // 서로 상계된 거래처)은 **남긴다** — 오갈 돈이 실재하는데 화면에서 사라지면 팝오버가
    // 바의 합계를 설명하지 못한다.
    (group) => group.amount !== 0 || group.campaigns.length > 0,
  );

  for (const group of groups) {
    group.campaigns.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }
  groups.sort((a, b) => directionRank(a.amount) - directionRank(b.amount) || Math.abs(b.amount) - Math.abs(a.amount));

  return {
    payable: sumAbs(groups, (amount) => amount < 0),
    receivable: sumAbs(groups, (amount) => amount > 0),
    groups,
    estimated: groups.some((group) => group.estimated),
  };
}

/** 보낼 돈(0) → 받을 돈(1) → 상계 0(2). 정렬 안에서 방향을 1차 키로 쓴다. */
function directionRank(amount: number): number {
  if (amount < 0) return 0;
  if (amount > 0) return 1;
  return 2;
}

function sumAbs(
  groups: readonly PartnerBreakdownGroup[],
  matches: (amount: number) => boolean,
): number {
  return groups.reduce(
    (total, group) => (matches(group.amount) ? total + Math.abs(group.amount) : total),
    0,
  );
}
