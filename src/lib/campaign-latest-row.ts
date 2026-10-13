/**
 * 캠페인 한 건을 서버에서 다시 읽어 화면 행을 최신으로 맞추는 클라이언트 도우미.
 *
 * 배경(2026-10-13 운영 관찰): 정산 화면의 패널 행은 페이지 캐시에서 와 저장 직후엔 옛 값일 수
 * 있다(`cache-tags.ts` IMMEDIATE_EXPIRY_TAGS). 패널을 열 때와 저장이 「값이 바뀜」 409
 * (`campaign-financial-guard.ts`)로 버려졌을 때 이 모듈로 최신 행을 받아 갈아끼운다.
 */
import type { CampaignRow } from "@/lib/crm-types";

/** `GET /api/campaigns/:id` — 브라우저 캐시를 쓰지 않는다. 실패는 던진다(호출처가 문구를 정한다). */
export async function fetchLatestCampaignRow(campaignId: string): Promise<CampaignRow> {
  const response = await fetch(`/api/campaigns/${campaignId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`campaign refetch failed: HTTP ${response.status}`);
  return (await response.json()) as CampaignRow;
}

/**
 * 단건 GET 은 목록 조회만 계산하는 필드(가격 위반 요약·셀러 캠페인 수)를 기본값(없음·0)으로
 * 돌려준다 — 그대로 갈아끼우면 패널을 **열기만 해도** 카드의 위반 배지가 사라진다. 그 필드는
 * 목록 행 값을 유지한다.
 */
export function mergeListOnlyFields(listRow: CampaignRow, fresh: CampaignRow): CampaignRow {
  return {
    ...fresh,
    hasPriceViolation: listRow.hasPriceViolation,
    violatedDealCount: listRow.violatedDealCount,
    campaignCount: listRow.campaignCount,
  };
}

/**
 * 재조회 결과가 화면 행과 다른지 가르는 키. 단건 GET 에는 목록 행에 없는 필드(`salesTask`)가
 * 붙어 통째 비교는 항상 「다름」이 된다 — 행 수정 시각과, 그 시각을 안 올릴 수 있는 자식 행
 * (부가 항목·품목)만 본다.
 */
export function campaignFreshnessKey(row: CampaignRow): string {
  return JSON.stringify([row.updatedAt, row.settlementItems ?? [], row.campaignDeals ?? []]);
}
