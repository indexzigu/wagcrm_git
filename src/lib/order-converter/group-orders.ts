/**
 * 발주서 행 그룹핑 — 브랜드사 전달 목적에 맞춘 배치.
 *
 * 발주서는 브랜드사가 그대로 보고 출고하는 주문내역 문서다. 한 주문(한 고객)의
 * 메인 품목과 추가구성상품(추가옵션)은 한 패키지로 합포장되므로, 행도 반드시
 * 같은 주문끼리 연속으로 붙어 있어야 한다(기존 수동 발주서 관행과 동일 —
 * 예: 배터리/케이블/파우치 3행 연속). 추가옵션을 파일 끝에 몰아 놓으면
 * 브랜드사가 묶음을 인지하지 못해 분리 출고·누락 위험이 생긴다.
 *
 * 규칙:
 * - 메인 행의 등장 순서(주문일 순 조회 결과)를 그룹 순서로 유지
 * - 같은 _orderId의 추가옵션 행은 그 주문의 메인 행들 바로 뒤에 배치
 * - 메인이 없는 추가옵션(엣지: 메인 취소 후 애드온만 잔존 등)은 뒤쪽에
 *   주문 단위로 이어 붙인다(출고는 여전히 필요하므로 누락 금지)
 */
export function interleaveAddonRows<T extends { _orderId?: string }>(mainRows: T[], addonRows: T[]): T[] {
  const sequence: string[] = [];
  const rowsByKey = new Map<string, T[]>();
  let anonSeq = 0;

  const keyOf = (row: T, prefix: string) =>
    row._orderId && String(row._orderId).trim() !== '' ? String(row._orderId) : `${prefix}${anonSeq++}`;

  for (const row of mainRows) {
    const key = keyOf(row, '__main_');
    if (!rowsByKey.has(key)) {
      sequence.push(key);
      rowsByKey.set(key, []);
    }
    rowsByKey.get(key)!.push(row);
  }

  for (const row of addonRows) {
    const key = keyOf(row, '__addon_');
    if (!rowsByKey.has(key)) {
      sequence.push(key); // 메인 없는 주문의 애드온 — 뒤에 주문 단위로 추가
      rowsByKey.set(key, []);
    }
    rowsByKey.get(key)!.push(row);
  }

  return sequence.flatMap((key) => rowsByKey.get(key)!);
}

/**
 * 유효 주문 집계에서 제외하는 상품주문 상태(결제대기·취소·미결제취소·반품·교환).
 * 진행중/마감 두 집계 경로가 이 상수를 공유해 "유효 주문" 정의가 서로 어긋나지 않게 한다(SSOT).
 *
 * ⚠️ 문자열은 네이버 커머스 productOrderStatus enum과 정확히 일치해야 한다. 과거 'PAY_WAITING'
 * (실제값 'PAYMENT_WAITING')·'CANCELED_BY_NOPAYMENT' 누락으로 결제대기·미결제취소 주문이 판매로
 * 오집계되어 수량·매출·주문수가 부풀려진 실사고가 있었다(2026-07-10). enum 추가 시 실데이터의
 * productOrderStatus 실값을 확인하고 넣을 것.
 */
export const INVALID_ORDER_STATUSES: string[] = ['PAYMENT_WAITING', 'CANCELED', 'CANCELED_BY_NOPAYMENT', 'RETURNED', 'EXCHANGED'];

/**
 * "주문건수"(주문번호 distinct) 집계용 키를 만든다.
 * - orderId(결제 단위 주문번호)가 있으면 그것을 키로 → 한 결제의 여러 상품주문번호가 1건으로 합쳐진다.
 *   (추가구성상품/사은품 라인도 메인과 같은 orderId를 공유하므로 자동으로 한 건에 흡수됨 = 부풀림 방지)
 * - orderId가 없으면 productOrderId로 폴백해 각 라인을 개별 주문으로 최소 보장(누락 방지).
 * 유효/취소 판정은 호출부의 유효 분기 안에서만 이 키를 모으면 되므로 여기서 상태는 다루지 않는다.
 */
export function resolveOrderCountKey(order: any): string {
  const oid = order?.orderId != null ? String(order.orderId).trim() : '';
  if (oid) return oid;
  const poid = order?.productOrderId != null ? String(order.productOrderId).trim() : '';
  return poid ? `po:${poid}` : '';
}
