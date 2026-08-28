// 셀러 목록 파생 세그먼트 — 단일 진실 원천 (client-safe, 순수).
//
// 왜 분리하나: 세그먼트 필터는 sellers-management의 useMemo 안에서 인라인으로 계산되는데,
// "미분석"(UX 감사 P0-3) 세그먼트가 추가되면서 분기가 4갈래로 늘었다. 순수 함수로 승격해
// 컴포넌트 하네스 없이 property test로 계약(active/prospect 기존 동작 + unanalyzed 신규)을
// 검증한다. seller-summary.ts는 서버 전용(getPrisma) 로더라 이 predicate의 집이 될 수 없어
// 별도 client-safe 모듈로 둔다.

import type { SellerSummary } from "@/lib/crm-types";

export type SellerSegment = "all" | "active" | "prospect" | "unanalyzed";

/**
 * 파생 세그먼트 predicate. 상태가 아니라 계산되는 사실(거래 이력·분석 유무)이므로 순수.
 * - all: 전체
 * - active: 거래 셀러 (campaignCount > 0)
 * - prospect: 발굴 후보 (campaignCount === 0)
 * - unanalyzed: 미분석 (aiComposite == null) — AI 점수 캐시가 비어있는 셀러
 */
export function matchesSellerSegment(seller: SellerSummary, segment: SellerSegment): boolean {
  switch (segment) {
    case "all":
      return true;
    case "active":
      return (seller.campaignCount ?? 0) > 0;
    case "prospect":
      return (seller.campaignCount ?? 0) === 0;
    case "unanalyzed":
      // == null 로 null/undefined 양쪽을 포착 (AI 프로필 미적용/미분석 환경 모두 미분석으로 간주)
      return seller.aiComposite == null;
    default:
      return true;
  }
}

/** 세그먼트로 걸러진 목록. 정렬은 호출부 책임(이 함수는 순서를 보존한다). */
export function filterSellersBySegment(
  sellers: SellerSummary[],
  segment: SellerSegment
): SellerSummary[] {
  if (segment === "all") return sellers;
  return sellers.filter((seller) => matchesSellerSegment(seller, segment));
}
