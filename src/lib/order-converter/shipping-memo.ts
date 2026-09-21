/**
 * 배송메시지(구매자가 남긴 배송 요청) 단일 해석 경로.
 *
 * 🪤 `shippingMemo` 는 `productOrder` 의 **형제 필드**다 — `shippingAddress` 안에 없다.
 * 종전 발주서 생성(execute·stream 라우트 4곳)이 `shippingAddress.shippingMemo` 를 읽어
 * 항상 `undefined` → 빈 문자열이 됐고, 브랜드 양식의 배송메시지 열(예: '특기사항')이
 * 늘 빈칸으로 나갔다. 실증(2026-09-21, 프로덕션 NaverOrderSnapshot 51건):
 * `shippingAddress` 의 키는 name·tel1·tel2·zipCode·baseAddress·detailedAddress·
 * addressType·isRoadNameAddress·latitude·longitude·buildingManagementNo 뿐이고
 * `shippingMemo` 는 한 건도 없다 — 같은 주문 객체의 최상위에 있다.
 *
 * 스냅샷 평면 계약은 `{...order, ...productOrder}`(naver-order-sync.normalizeQueriedOrder)라
 * 주문(order) 계층에 실려 오는 응답도 방어적으로 함께 본다.
 */
export function resolveShippingMemo(
  productOrder: { shippingMemo?: unknown; shippingAddress?: Record<string, unknown> | null } | null | undefined,
  order?: { shippingMemo?: unknown } | null
): string {
  const candidates = [
    productOrder?.shippingMemo,
    order?.shippingMemo,
    // 과거 경로 — 네이버가 주소 객체에 넣어주는 응답이 있다면 그대로 살린다.
    productOrder?.shippingAddress?.shippingMemo,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}
