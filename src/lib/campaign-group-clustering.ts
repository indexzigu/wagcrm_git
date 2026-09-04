/**
 * CG-1 조합 캠페인 소급 클러스터링 유틸 (블루프린트 §4).
 *
 * 목적: `groupId IS NULL` 캠페인들을 (같은 셀러 · 기간 근접) 기준으로 묶어 조합
 * 캠페인 그룹 후보를 제안한다. 소급 스크립트(`scripts/backfill-campaign-groups.ts`)와
 * 합류 제안 경로(ⓑ)가 **동일 정본**을 공유한다 — 순수 함수, DB I/O 없음.
 *
 * 핵심 규칙:
 * - 셀러(sellerId)별로 파티션한 뒤 startDate 오름차순 정렬, 롤링 엔벨로프 그리디로 병합.
 * - 같은 `dealId`가 한 클러스터에 두 번 나타나면 **분리**한다(회차 재판매를 조합으로 오인 방지).
 * - 조합 그룹 "제안"은 멤버 ≥2 클러스터만.
 *
 * 재구매 기능의 주문 클러스터링(`order-converter/campaign-insights.ts`)은 ordererNo 기반이라
 * 목적이 다르며 재사용 대상이 아니다(신규 유틸이 단일 정본).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 조합 후보로 볼 기간 근접 창(일). 소급 스크립트(`--window` 기본값)와 화면의
 * 「그룹으로 묶기」 후보 조회가 **같은 값을 공유**해야 한다 — 갈리면 스크립트가
 * 제안한 묶음이 화면에서는 후보로 안 보이고, 오너는 그 침묵을 결함으로 조사한다.
 */
export const GROUP_WINDOW_DAYS = 3;

/** 클러스터링에 필요한 최소 캠페인 형태. 소비자는 이 필드를 포함한 상위 타입을 넘길 수 있다. */
export type CampaignClusterInput = {
  id: string;
  sellerId: string;
  dealId: string;
  startDate: Date;
  endDate: Date;
};

/** 롤링 엔벨로프(현재 클러스터의 기간 합집합 경계). */
type DateEnvelope = { startDate: Date; endDate: Date };

/** 같은 날짜 윈도우 안에서 dealId 중복으로 분리된 캠페인(회차 오인 방지) — 리포트용. */
export type SameDealSplit = {
  sellerId: string;
  dealId: string;
  /** 분리되어 나온(윈도우상으로는 묶일 수 있었으나 dealId 충돌로 제외된) 캠페인 id. */
  campaignId: string;
};

export type DateWindowClusterResult<T extends CampaignClusterInput> = {
  /** 최종 파티션(모든 크기). 각 캠페인은 정확히 한 클러스터에 속한다. */
  clusters: T[][];
  /** 조합 그룹 제안(멤버 ≥2 클러스터만). */
  proposals: T[][];
  /** dealId 중복으로 분리된 캠페인 목록(리포트용). */
  sameDealSplits: SameDealSplit[];
};

/**
 * 두 기간이 겹치거나(overlap) `windowDays` 이내로 근접한지 판정한다.
 *
 * - 겹침: `a.start <= b.end && b.start <= a.end`.
 * - 근접: 두 기간 사이 간격(일)이 `windowDays` 이하.
 *
 * 경계 포함: 간격이 정확히 `windowDays`일이면 근접으로 인정한다(<=).
 */
export function overlapsOrNear(
  a: DateEnvelope,
  b: DateEnvelope,
  windowDays: number,
): boolean {
  // 겹침
  if (a.startDate.getTime() <= b.endDate.getTime() && b.startDate.getTime() <= a.endDate.getTime()) {
    return true;
  }
  // 간격(a가 앞이면 b.start - a.end, b가 앞이면 a.start - b.end)
  const gapMs =
    a.endDate.getTime() < b.startDate.getTime()
      ? b.startDate.getTime() - a.endDate.getTime()
      : a.startDate.getTime() - b.endDate.getTime();
  const gapDays = gapMs / DAY_MS;
  return gapDays <= windowDays;
}

/**
 * `YYYY-MM-DD` 범위를 근접 창만큼 양옆으로 넓힌다.
 *
 * 쓰는 곳: **순수 겹침**으로 질의하는 소비처(`campaignGroupRepository.findSuggestions` 의
 * `startDate <= rangeEnd AND endDate >= rangeStart`)를 `overlapsOrNear(..., windowDays)` 와
 * **같은 집합**으로 만들 때. 대수적으로 등가다 —
 * `(a.start - w <= b.end) AND (b.start <= a.end + w)` 는 `겹침 또는 간격 <= w` 와 같다.
 *
 * ⛔ 소비처에서 날짜 산술을 다시 적지 말 것. 합류 후보(기존 그룹)와 묶기 후보(미그룹
 * 캠페인)가 서로 다른 날짜 규칙을 쓰면, 창 밖 그룹이 합류 목록엔 없는데 그 멤버는
 * "이미 다른 그룹에 속해 있다"로 집계되어 사용자에게 막다른 길이 된다.
 */
export function expandYmdRangeByWindow(
  range: { startDate: string; endDate: string },
  windowDays = GROUP_WINDOW_DAYS,
): { startDate: string; endDate: string } {
  const shift = (ymd: string, days: number) =>
    new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * DAY_MS)
      .toISOString()
      .slice(0, 10);
  return {
    startDate: shift(range.startDate, -windowDays),
    endDate: shift(range.endDate, windowDays),
  };
}

/**
 * 캠페인 배열을 셀러별 파티션 → startDate 정렬 → 롤링 엔벨로프 그리디로 클러스터링한다.
 *
 * 반환:
 * - `clusters`: 전체 파티션(단건 포함).
 * - `proposals`: 멤버 ≥2 클러스터(조합 그룹 후보).
 * - `sameDealSplits`: dealId 중복으로 분리된 캠페인(리포트용).
 *
 * 결정성: 셀러 그룹은 첫 등장 순서, 그 안은 (startDate → id) 안정 정렬로 순회한다.
 */
export function clusterByDateWindow<T extends CampaignClusterInput>(
  campaigns: T[],
  windowDays = GROUP_WINDOW_DAYS,
): DateWindowClusterResult<T> {
  const clusters: T[][] = [];
  const sameDealSplits: SameDealSplit[] = [];

  for (const group of partitionBySeller(campaigns)) {
    const sorted = [...group].sort(
      (a, b) => a.startDate.getTime() - b.startDate.getTime() || a.id.localeCompare(b.id),
    );

    let current: T[] = [];
    let envelope: DateEnvelope | null = null;
    let dealIds = new Set<string>();

    const flush = () => {
      if (current.length > 0) clusters.push(current);
      current = [];
      envelope = null;
      dealIds = new Set<string>();
    };

    for (const campaign of sorted) {
      if (current.length === 0 || envelope === null) {
        current = [campaign];
        envelope = { startDate: campaign.startDate, endDate: campaign.endDate };
        dealIds = new Set([campaign.dealId]);
        continue;
      }

      const near = overlapsOrNear(envelope, campaign, windowDays);
      const dealCollision = dealIds.has(campaign.dealId);

      if (near && !dealCollision) {
        // 롤링 엔벨로프 확장(정렬상 start는 단조 증가하므로 end만 확장하면 충분).
        current.push(campaign);
        if (campaign.endDate.getTime() > envelope.endDate.getTime()) {
          envelope = { startDate: envelope.startDate, endDate: campaign.endDate };
        }
        dealIds.add(campaign.dealId);
      } else {
        if (near && dealCollision) {
          // 윈도우상 묶일 수 있었으나 같은 딜(회차) → 분리 기록 후 새 클러스터 시작.
          sameDealSplits.push({
            sellerId: campaign.sellerId,
            dealId: campaign.dealId,
            campaignId: campaign.id,
          });
        }
        flush();
        current = [campaign];
        envelope = { startDate: campaign.startDate, endDate: campaign.endDate };
        dealIds = new Set([campaign.dealId]);
      }
    }
    flush();
  }

  const proposals = clusters.filter((c) => c.length >= 2);
  return { clusters, proposals, sameDealSplits };
}

/** sellerId별로 첫 등장 순서를 보존하며 파티션한다. */
function partitionBySeller<T extends CampaignClusterInput>(campaigns: T[]): T[][] {
  const bySeller = new Map<string, T[]>();
  for (const campaign of campaigns) {
    const bucket = bySeller.get(campaign.sellerId);
    if (bucket) {
      bucket.push(campaign);
    } else {
      bySeller.set(campaign.sellerId, [campaign]);
    }
  }
  return [...bySeller.values()];
}
