/**
 * 네이버 `productClass`(상품 분류) 판정 SSOT.
 *
 * ## 왜 한 곳인가
 *
 * "이 주문 라인이 추가구성상품(추가옵션)인가"는 **주문 귀속의 분기점**이다 — 참이면
 * 1차 매칭에서 빼고 2차 패스(동일 `productId` 메인 품목이 이 캠페인에 귀속됐는지)로
 * 미룬다. 그 술어가 집계 표면 7곳에 손으로 복사돼 있었다(발주 실행 2경로 · 캠페인
 * 핸들러 · 모바일 펄스 · 마감 캐시 · 캠페인 주문 · 미발주 목록). 라인 하나가 메인으로
 * 오분류되면 매출·수량·주문수가 그 자리에서 갈리는데, 사본이 갈려도 **타입도 테스트도
 * 잡지 못한다** — `INVALID_ORDER_STATUSES` 가 오타 하나로 전 지표를 부풀린 것과 같은
 * 부류다(P7 Valid-Order Enum Discipline).
 *
 * ## 왜 NFC 정규화를 거치는가
 *
 * 값의 형태를 정하는 주체가 우리가 아니다 — 네이버 커머스 API 응답이 그대로 스냅샷에
 * 저장된다(`normalizeQueriedOrder` 는 필드 병합만 하고 유니코드 정규화를 하지 않는다).
 * 같은 한글이 **조합형(NFC)**과 **자모 분리형(NFD)** 두 벌로 존재하고, 눈으로는 구분되지
 * 않는데 `===` 는 빗나간다. 그리고 이 축의 실패는 예외 없이 **조용하다** — 추가구성상품이
 * 메인으로 오분류돼 매칭에 실패하면 그 라인은 그냥 집계에서 사라지고, 화면에서는
 * 「그 캠페인 주문이 원래 그만큼」과 구분되지 않는다.
 *
 * ⚠️ **현재 프로덕션 데이터는 NFD 오염이 없다**(2026-09-02 저장 스냅샷 전수 대조 —
 * 관측된 `productClass` 값이 전부 NFC). 즉 이 정규화는 **지금 무엇을 고치는 것이 아니라**
 * 형태가 바뀌었을 때 조용히 갈리지 않게 하는 예방이다. 이 문장을 「정규화가 버그를
 * 고쳤다」로 바꿔 적지 말 것.
 *
 * ⛔ `normalizeForCompare`(NFC + 공백 제거 + 소문자화)를 쓰지 말 것 — 이 값은 네이버가
 * 정한 **분류 enum** 이라 정확 일치 자리다. 공백까지 뭉개면 사양에 없는 값을 우리가
 * 임의로 받아주는 셈이고, 네이버가 새 분류를 추가했을 때 그것이 기존 분류로 흡수돼
 * 조용히 오분류된다. 정규화 단계를 여기서 다시 적지도 말 것(정본은 `text-normalize.ts`).
 */
import { toNfc } from '@/lib/text-normalize';

/**
 * 추가구성상품(추가옵션)의 `productClass` 값 — 네이버 응답 어휘 그대로다.
 *
 * ⚠️ 이 문자열은 **NFC 로 커밋**한다(레포 전반의 전제 — `text-normalize.ts`).
 * 비교 상대는 `isSupplementProduct` 가 NFC 로 맞춰 주므로 여기만 지키면 된다.
 */
export const SUPPLEMENT_PRODUCT_CLASS = '추가구성상품';

/** `productClass` 를 들고 있는 주문 라인의 최소 형태. 소비처의 주문 타입이 서로 달라 구조로만 받는다. */
export interface ProductClassLike {
  productClass?: string | null;
}

/**
 * 이 주문 라인이 추가구성상품(추가옵션)인가.
 *
 * 참이면 호출부는 1차 매칭에서 제외하고 2차 귀속 패스로 미룬다 — **그 2차 규칙 자체는
 * 표면마다 다르므로 여기서 다루지 않는다**(이 함수는 분류만 답한다).
 *
 * 값이 없거나 문자열이 아니면 `false` — 추가구성상품이 아니라는 뜻이고, 호출부에서
 * 메인 품목으로 1차 매칭을 타게 된다(종전 `=== '추가구성상품'` 과 같은 처분).
 */
export function isSupplementProduct(order: ProductClassLike | null | undefined): boolean {
  const raw = order?.productClass;
  if (typeof raw !== 'string') return false;
  return toNfc(raw) === SUPPLEMENT_PRODUCT_CLASS;
}
