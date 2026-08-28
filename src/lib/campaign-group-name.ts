/**
 * CG-1 캠페인 그룹 이름 자동 생성 유틸 (D4 확정 포맷).
 *
 * 순수 함수. `src/lib/campaign-name.ts`의 스타일/절단(100자)을 그대로 따른다.
 * 셀러 별칭 우선(P2 Seller Alias Priority)은 호출자의 책임 — 이 함수는 넘겨받은
 * `sellerLabel`을 그대로 쓴다(campaign-name.ts와 동일 관행).
 */

/**
 * 그룹 이름을 생성한다.
 *
 * 포맷(D4): `"[셀러라벨] 대표딜명 외 N-1건"` (N = memberCount).
 * - 예) memberCount=3 → `"[가온] 비타민 외 2건"`.
 * - memberCount ≤ 1(비정상 — 그룹은 항상 ≥2)일 때는 접미사 없이 `"[셀러라벨] 대표딜명"`.
 * - `representativeDealName` 또는 `sellerLabel`이 null/빈 문자열이면 null 반환.
 * - 100자에서 절단(campaign-name.ts와 동일).
 *
 * @param representativeDealName 대표 딜 이름(보통 시작일이 가장 이른 멤버의 딜명)
 * @param sellerLabel 화면 표기용 셀러 라벨(별칭 우선은 호출자가 해결)
 * @param memberCount 그룹 멤버 수
 * @returns 생성된 그룹 이름, 입력이 불충분하면 null
 */
export function generateGroupName(
  representativeDealName: string | null,
  sellerLabel: string | null,
  memberCount: number,
): string | null {
  if (!representativeDealName || !sellerLabel) {
    return null;
  }

  const others = memberCount - 1;
  const name =
    others >= 1
      ? `[${sellerLabel}] ${representativeDealName} 외 ${others}건`
      : `[${sellerLabel}] ${representativeDealName}`;

  return name.slice(0, 100);
}
