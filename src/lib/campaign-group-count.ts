// 캠페인 그룹 "유효 캠페인 수" — 단일 진실 원천 (client-safe, 순수).
//
// 왜 존재하나: 그룹(CampaignGroup)은 실캠페인 1개를 딜별 N행(SalesCampaign)으로 분할
// 운영한 것이다(CG-1). 그래서 "캠페인 개수"를 노출하는 표면(대시보드 KPI·셀러 누적 수)은
// 그룹을 1건으로 세야 실세계 캠페인 수와 일치한다(오너 확정 2026-07-30).
//
// ⚠️ 모든 campaignCount 가 이 함수 대상이 아니다 — "행 수/행 존재"가 정답인 표면은
// 행 단위를 유지한다(오너 확정, 같은 날): 셀러 삭제 가드(_count)·딜 상세 "연결된 캠페인
// N건"(리스트 행 수)·파이프라인 칸반 카운트(카드=멤버 단위, 상태는 딜별 독립)·정산
// 리포트(정산은 딜 단위 금액·행이 정본). 두 의미를 섞으면 화면 간 숫자가 어긋난다.

export type GroupCountable = { groupId: string | null };

/** 유효 캠페인 수 = distinct(groupId) + 미그룹 행 수. */
export function countEffectiveCampaigns(items: readonly GroupCountable[]): number {
  const groups = new Set<string>();
  let ungrouped = 0;
  for (const item of items) {
    if (item.groupId != null) groups.add(item.groupId);
    else ungrouped += 1;
  }
  return groups.size + ungrouped;
}

export type EffectivePeriod = { startDate: Date; endDate: Date };

/**
 * 월 환산 가중 집계용 "유효 캠페인 기간" 목록 — 그룹은 멤버 포락선(min start ~ max end)
 * 1개로, 미그룹 캠페인은 자기 기간 그대로. 그룹 기간을 롤업 컬럼이 아니라 멤버에서
 * 직접 합성하는 이유: 스키마상 그룹 날짜는 SoT가 아니라 표시용 롤업이다(CG-1 ⭐③).
 */
export function buildEffectiveCampaignPeriods<T extends GroupCountable & EffectivePeriod>(
  campaigns: readonly T[],
): EffectivePeriod[] {
  const byGroup = new Map<string, EffectivePeriod>();
  const result: EffectivePeriod[] = [];
  for (const campaign of campaigns) {
    if (campaign.groupId == null) {
      result.push({ startDate: campaign.startDate, endDate: campaign.endDate });
      continue;
    }
    const envelope = byGroup.get(campaign.groupId);
    if (!envelope) {
      const created = { startDate: campaign.startDate, endDate: campaign.endDate };
      byGroup.set(campaign.groupId, created);
      result.push(created); // 입력 순서 보존 — 같은 객체를 계속 넓힌다
      continue;
    }
    if (campaign.startDate < envelope.startDate) envelope.startDate = campaign.startDate;
    if (campaign.endDate > envelope.endDate) envelope.endDate = campaign.endDate;
  }
  return result;
}

/**
 * 셀러별 유효 캠페인 수 — Prisma `salesCampaign.groupBy({ by: ["sellerId","groupId"] })`
 * 결과를 접는다(행 fetch 없이 집계 쿼리 한 번, P7 egress 규율). 그룹 행은 1로, 미그룹
 * 버킷(groupId null)은 행 수 그대로 더한다. 그룹은 전 멤버 동일 셀러가 불변식이지만
 * (campaignGroupService), 방어적으로 (sellerId, groupId) 쌍 단위로 센다.
 */
export function tallyEffectiveCampaignCounts(
  rows: readonly { sellerId: string; groupId: string | null; rowCount: number }[],
): Map<string, number> {
  const bySeller = new Map<string, number>();
  for (const row of rows) {
    const add = row.groupId != null ? 1 : row.rowCount;
    bySeller.set(row.sellerId, (bySeller.get(row.sellerId) ?? 0) + add);
  }
  return bySeller;
}
