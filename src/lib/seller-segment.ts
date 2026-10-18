// 셀러 목록 파생 세그먼트 — 단일 진실 원천 (client-safe, 순수).
//
// 왜 분리하나: 세그먼트 필터는 sellers-management의 useMemo 안에서 인라인으로 계산되는데,
// "미분석"(UX 감사 P0-3) 세그먼트가 추가되면서 분기가 4갈래로 늘었다. 순수 함수로 승격해
// 컴포넌트 하네스 없이 property test로 계약(active/prospect 기존 동작 + unanalyzed 신규)을
// 검증한다. seller-summary.ts는 서버 전용(getPrisma) 로더라 이 predicate의 집이 될 수 없어
// 별도 client-safe 모듈로 둔다.

import type { SellerSummary } from "@/lib/crm-types";
import { computeDormancyTier } from "@/lib/seller-dormancy";
import { campaignRecency } from "@/lib/partner-seller-display";

export type SellerSegment = "all" | "active" | "prospect" | "unanalyzed" | "dormant";

/**
 * 파생 세그먼트 predicate. 상태가 아니라 계산되는 사실(거래 이력·분석 유무)이므로 순수.
 * - all: 전체
 * - active: 거래 셀러 (campaignCount > 0)
 * - prospect: 발굴 후보 (campaignCount === 0)
 * - unanalyzed: 미분석 (aiComposite == null) — AI 점수 캐시가 비어있는 셀러
 * - dormant: 휴면 — 재계약 검토 대상(오너 결정 2026-10-18). 판정은 `seller-dormancy.ts` 의
 *   `computeDormancyTier` 가 DORMANT(90~180일)로 낸 셀러뿐이다 — 규칙을 여기서 다시 쓰지 않는다.
 *   180일+(제외 티어)는 「거래 리듬」 열이 무채색으로 두는 "사실상 제외"라 이 보기에도 넣지 않는다.
 *   `runCount` 가 없으면(집계 실패) 표가 「—」로 그리는 행이라 휴면으로 단정하지 않는다.
 *   **시작예정·진행중 캠페인이 있는 셀러는 뺀다**(2026-10-18 ss-ux P1-2): 마지막 진행이 오래됐어도 다음 캠페인이
 *   잡혀 있으면 재계약 검토 대상이 아니다. 신호는 목록의 「시작예정」·「진행중」 표시와 같은 `campaignRecency`
 *   (서버 집계 우선, 없으면 캡 배열 — 드랍 제외)다 — 휴면 티어 자체(`computeDormancyTier`)는 바꾸지 않는다.
 *   이 보기는 오너가 **고르는** 필터다 — 기본 보기·기본 정렬에 휴면을 쓰지 않는다는 SSOT 조항(D10)은 그대로.
 */
export function matchesSellerSegment(
  seller: SellerSummary,
  segment: SellerSegment,
  now: Date = new Date(),
): boolean {
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
    case "dormant":
      return isDormantForReview(seller, now);
    default:
      return true;
  }
}

/**
 * 「재계약 검토 대상 휴면」 — 휴면 보기(필터)와 셀러 표의 휴면 배지가 **함께** 쓰는 한 판정(2026-10-18 결정:
 * 배지와 필터가 갈리면 「휴면」 배지가 붙었는데 휴면 보기엔 없는 셀러가 생긴다).
 * = 티어 SSOT(`computeDormancyTier`)가 DORMANT && 시작예정·진행중 캠페인 없음(`campaignRecency`, 목록의 「시작예정」
 * 표시와 같은 신호). 휴면 규칙을 새로 쓰지 않는다 — 티어는 그대로 두고 「다음 캠페인이 잡힌 셀러」만 뺀다.
 * `runCount` 가 없으면(집계 실패) 단정하지 않는다.
 */
export function isDormantForReview(seller: SellerSummary, now: Date = new Date()): boolean {
  if (seller.runCount === undefined) return false;
  if (computeDormancyTier(seller.lastRunStartAt ?? null, now).tier !== "DORMANT") return false;
  const recency = campaignRecency(seller.campaigns, now.getTime(), seller);
  return recency?.kind !== "upcoming" && recency?.kind !== "active";
}

/** 세그먼트로 걸러진 목록. 정렬은 호출부 책임(이 함수는 순서를 보존한다). */
export function filterSellersBySegment(
  sellers: SellerSummary[],
  segment: SellerSegment,
  now: Date = new Date(),
): SellerSummary[] {
  if (segment === "all") return sellers;
  return sellers.filter((seller) => matchesSellerSegment(seller, segment, now));
}

/**
 * 「휴면」 보기 정렬 — 오래 쉰 셀러 먼저(마지막 진행 시작일 오름차순). 휴면 보기 안에서는 모든 행에
 * 시작일이 있지만, 비교기는 단독으로도 안전하게 시작일 없는 행을 뒤로 보낸다.
 */
export function compareByLongestDormancy(a: SellerSummary, b: SellerSummary): number {
  const ta = a.lastRunStartAt ? Date.parse(a.lastRunStartAt) : Number.POSITIVE_INFINITY;
  const tb = b.lastRunStartAt ? Date.parse(b.lastRunStartAt) : Number.POSITIVE_INFINITY;
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
}
