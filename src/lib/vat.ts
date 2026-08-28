/**
 * VAT 포함 금액 → (공급가액, 세액) 분해 — 이 레포의 **유일한** 변환 지점.
 *
 * ## 왜 별도 모듈인가
 *
 * 이 식(`/1.1`·`×0.1`)은 세무 처리 보드(`tax-filing-board.ts`)와 세금계산서 빌더
 * (`tax-invoice-builder.ts`) 양쪽이 쓰는데, **두 파일은 서로 import 할 수 없다** —
 * 보드가 빌더의 `validateTaxInvoiceCampaigns`·`normalizeBusinessNumber` 를 값으로
 * 가져가므로 반대 방향 값 import 는 런타임 순환이 된다.
 *
 * 그래서 종전에는 보드에만 이 식이 있었고 빌더는 보드가 낸 금액을 **그대로 쓰는**
 * 것으로 문제를 피했다. 2-A 에서 빌더가 품목 행을 나누며 자기도 변환을 해야 해서,
 * 식을 빌더 안에 다시 적으면 **두 번째 인코딩**이 된다 — 이 도메인이 여섯 번 정정된
 * 그 패턴이다. 순환 없이 하나로 두는 방법이 이 모듈이다.
 *
 * ⚠️ 이 함수를 호출부에 인라인으로 다시 쓰지 말 것. 화면에 보인 금액과 오너가
 * 홈택스에 올리는 파일의 금액이 갈리면, 어느 쪽이 맞는지 모른 채 신고하게 된다.
 */

/** VAT 포함 금액을 공급가액·세액으로 나눈다. 음수(역방향 정정)도 그대로 다룬다. */
export function splitVatIncluded(vatIncludedAmount: number): {
  supplyAmount: number;
  taxAmount: number;
} {
  const supplyAmount = Math.round(vatIncludedAmount / 1.1);
  return { supplyAmount, taxAmount: Math.round(supplyAmount * 0.1) };
}
