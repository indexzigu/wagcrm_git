// 판매관리 칸반 카드 최저가 위반 배지(UX1-C) 데이터 해소 — 순수함수(fs/prisma 의존 없음).
//
// 설계(청사진 §C): 캠페인 딜들(메인+하위)의 "최신" PriceMonitorSnapshot 중 verdict=VIOLATED가
// 1건 이상이면 해당 캠페인을 위반으로 집계한다. "최신"은 dealId별 snapshotDate 최댓값 1건
// (같은 날 재실행 시 upsertDaily가 덮어쓰므로 dealId+snapshotDate 조합은 사실상 유일하지만,
// 방어적으로 배열 순서상 뒤쪽 값을 우선한다).
//
// N+1 회피: 이 모듈은 순수 리듀서만 제공한다. 실제 DB 조회는 호출부(cached-crm-data 등)에서
// "이번 응답에 포함된 모든 캠페인의 dealId 전체"를 단일 findMany로 가져와 여기에 넘긴다.

import type { PriceVerdict } from "./verdict";

export type SnapshotVerdictRow = {
  dealId: string;
  snapshotDate: string;
  verdict: PriceVerdict;
};

/**
 * 스냅샷 원본 행 목록에서 dealId별 "최신"(snapshotDate 최댓값) verdict만 남긴다.
 * 날짜 문자열은 YYYY-MM-DD 포맷(snapshotDate 컬럼 규약)이라 사전식 비교로 최신 판정이 가능하다.
 */
export function resolveLatestVerdictByDeal(
  rows: SnapshotVerdictRow[],
): Map<string, PriceVerdict> {
  const latestDateByDeal = new Map<string, string>();
  const verdictByDeal = new Map<string, PriceVerdict>();

  for (const row of rows) {
    const currentLatestDate = latestDateByDeal.get(row.dealId);
    if (currentLatestDate === undefined || row.snapshotDate >= currentLatestDate) {
      latestDateByDeal.set(row.dealId, row.snapshotDate);
      verdictByDeal.set(row.dealId, row.verdict);
    }
  }

  return verdictByDeal;
}

export type CampaignViolationSummary = {
  violatedDealCount: number;
};

/**
 * 캠페인별 위반 딜 개수를 집계한다. 위반 딜이 0건인 캠페인은 결과 Map에 아예 포함되지
 * 않는다(호출부에서 `.has(campaignId)`로 배지 표시 여부를 간단히 판정할 수 있도록).
 * 스냅샷 자체가 없는 딜(latestVerdictByDeal에 키가 없음)은 위반으로 세지 않는다.
 */
export function buildViolatedCampaignSummaries(
  campaignDealIds: Map<string, string[]>,
  latestVerdictByDeal: Map<string, PriceVerdict>,
): Map<string, CampaignViolationSummary> {
  const result = new Map<string, CampaignViolationSummary>();

  for (const [campaignId, dealIds] of campaignDealIds) {
    const violatedDealCount = dealIds.filter(
      (dealId) => latestVerdictByDeal.get(dealId) === "VIOLATED",
    ).length;

    if (violatedDealCount > 0) {
      result.set(campaignId, { violatedDealCount });
    }
  }

  return result;
}
