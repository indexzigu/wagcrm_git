// F3 소개 계보 계측 (GROWTH_FLYWHEEL_PLAN.md §F3) — F6가 적립한 유입경로·소개자 데이터를
// 운영 판단으로 전환한다. 소개는 이 사업의 유일한 고LTV 획득 채널이지만 "드물고 우연적,
// 계측 안 됨"이 문제였다(소유자). 이 모듈은 두 가지를 보이게 한다:
//   1) 유입 경로 분포 — 셀러가 실제로 어디서 오는가
//   2) 커넥터 리더보드 — 누가 소개를 많이 하고, 그 소개가 실적으로 이어지는가
//      → 관계를 키울(금전 인센티브 없이) 핵심 소개자를 식별한다.
//
// 순수 함수 — 셀러 목록(이미 로드된 데이터)만 입력받아 클라이언트에서 계산한다. 신규 쿼리 없음.

import { acquisitionChannelLabels } from "./crm-types";

type SellerLike = {
  id: string;
  name: string;
  alias?: string | null;
  acquisitionChannel?: string | null;
  referredById?: string | null;
  campaigns?: Array<{ actualSales: number | null }>;
};

export type AcquisitionBucket = {
  channel: string; // 원본 키 또는 "UNKNOWN"
  label: string; // 한국어 라벨
  count: number;
};

export type ConnectorRow = {
  connectorId: string;
  connectorName: string; // alias 우선
  referredCount: number;
  activeReferredCount: number; // 거래(캠페인 1건 이상) 이력 있는 소개 셀러 수
  downstreamSales: number; // 소개한 셀러들의 캠페인 실매출 합
};

function displayName(s: SellerLike): string {
  return s.alias && s.alias.trim() !== "" ? s.alias : s.name;
}

function sellerSales(s: SellerLike): number {
  return (s.campaigns ?? []).reduce((sum, c) => sum + (c.actualSales ?? 0), 0);
}

/** 유입 경로별 셀러 수. 미태깅은 "UNKNOWN"으로 모으고, 많은 순으로 정렬(동수는 라벨순). */
export function computeAcquisitionBreakdown(sellers: SellerLike[]): AcquisitionBucket[] {
  const counts = new Map<string, number>();
  for (const s of sellers) {
    const key = s.acquisitionChannel && s.acquisitionChannel.trim() !== "" ? s.acquisitionChannel : "UNKNOWN";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([channel, count]) => ({
      channel,
      label: channel === "UNKNOWN" ? "미분류" : acquisitionChannelLabels[channel] ?? channel,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"));
}

/**
 * 커넥터 리더보드 — 다른 셀러를 1명 이상 소개한 셀러만.
 * referredById가 실재 셀러를 가리킬 때만 집계(끊어진 참조는 무시).
 * 소개 수 → 다운스트림 매출 순으로 정렬.
 */
export function computeConnectorLeaderboard(sellers: SellerLike[]): ConnectorRow[] {
  const byId = new Map<string, SellerLike>();
  for (const s of sellers) byId.set(s.id, s);

  const agg = new Map<string, ConnectorRow>();
  for (const s of sellers) {
    const refId = s.referredById;
    if (!refId) continue;
    const connector = byId.get(refId);
    if (!connector) continue; // 끊어진 참조 — 집계 제외

    let row = agg.get(refId);
    if (!row) {
      row = {
        connectorId: refId,
        connectorName: displayName(connector),
        referredCount: 0,
        activeReferredCount: 0,
        downstreamSales: 0,
      };
      agg.set(refId, row);
    }
    row.referredCount += 1;
    const sales = sellerSales(s);
    if ((s.campaigns ?? []).length > 0) row.activeReferredCount += 1;
    row.downstreamSales += sales;
  }

  return Array.from(agg.values()).sort(
    (a, b) => b.referredCount - a.referredCount || b.downstreamSales - a.downstreamSales
  );
}

/** 소개(REFERRAL)로 유입된 셀러 중 실제 거래로 이어진 비율 — 소개 채널의 전환 건강도. */
export function computeReferralConversion(sellers: SellerLike[]): {
  referred: number;
  converted: number;
  rate: number;
} {
  let referred = 0;
  let converted = 0;
  for (const s of sellers) {
    if (s.acquisitionChannel !== "REFERRAL") continue;
    referred += 1;
    if ((s.campaigns ?? []).length > 0) converted += 1;
  }
  return { referred, converted, rate: referred > 0 ? (converted / referred) * 100 : 0 };
}
