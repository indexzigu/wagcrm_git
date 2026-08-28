/**
 * 네이버 상품주문번호 판별 — 순수 숫자 또는 숫자-숫자 형태(최소 8자리)만 유효.
 *
 * 회신 워크북에는 네이버에 존재하지 않는 '주문번호처럼 생긴' 행이 섞여 들어온다:
 * - 발주서의 '사은품' 시트: 3PL에 사은품 줄을 분리해 태우려고 부모 주문번호에 `_02G`
 *   같은 접미사를 붙인 가상 번호(형식: `<16자리 상품주문번호>_02G`).
 * - 트리프 회신의 '이벤트(트리프지원)' 등 비주문 문자열 행.
 * 둘 다 네이버에 제출하면 400 '처리 권한이 없는 상품 주문 번호'로 반려된다.
 *
 * order-parser가 아니라 별도 모듈인 이유: order-parser는 xlsx를 정적 import하는데,
 * 클라이언트(order-dashboard)가 이 판별을 값으로 import하므로 거기 두면 xlsx 번들이
 * 통째로 클라이언트에 실린다(대시보드는 의도적으로 `await import('xlsx')`만 쓴다).
 */
export const NAVER_ORDER_ID_PATTERN = /^\d[\d\-]{7,}$/;

export function isNaverProductOrderId(value: unknown): boolean {
  return NAVER_ORDER_ID_PATTERN.test(String(value ?? '').trim());
}
