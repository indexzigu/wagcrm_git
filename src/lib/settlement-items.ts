/**
 * 캠페인 정산 **부가 항목** 판정 SSOT — 순수 함수(Prisma 무의존·client-safe).
 *
 * 설계 정본: `docs/private/specs/2026-08-07-settlement-money-separation-design.md`
 * (오너 승인 2026-08-08).
 *
 * ## 이 모듈이 존재하는 이유
 *
 * 캠페인의 돈은 세 성격으로 움직이는데 모델은 「매출 × 요율」 파생 하나뿐이었다:
 * 물품대금(공급사 → 우리) · 부대비용(양방향) · 통과 항목(브랜드사 → 우리 → 셀러).
 * 담을 자리가 없어서 세금계산서 대조가 구조적으로 어긋났고, 그 금액을 맞추려고
 * `actualSales`·`settlementSales` 에 부대비용을 섞는 순간 **셀러 정산이 오염된다.**
 * 이 모듈은 그 "섞지 않아도 되는 자리"의 판정부다.
 *
 * ## ⛔ 절대 불변식 (오너 확정)
 *
 * ```
 * 셀러 정산 기준 = actualSales × 셀러수수료율
 * ```
 *
 * 부가 항목은 **어떤 조합이라도 이 기준에 들어가지 않는다.** 셀러 대상 항목조차
 * "지급 총액"에만 더해지고 기준액은 건드리지 않는다(기준과 총액이 갈리는 것이
 * 정상 상태이며, 화면이 그 둘을 다른 캐리어로 말한다).
 * 저장 파생식 `operatingProfit` 도 바꾸지 않는다 — 손익 반영은 **표시 계층의
 * 「조정 후 손익」** 이다(`resolveAdjustedOperatingProfit`).
 * 이 두 금지는 `settlement-items.contract.test.ts` 가 소스 스캔으로 강제한다.
 *
 * ## 저장 축이 「계산서 방식 × 대상」인 이유 (오너 7차 확정)
 *
 * 종전 안은 「브랜드/셀러 반영」 토글이었는데, 그러면 계산서 방향을 **파생 추론**
 * 해야 했다. 이 레포가 같은 도메인을 세 번 잘못 짚은 자리가 전부 "방향을 다시
 * 유도하는" 코드였다(`tax-filing-board.ts` 헤더 주석). 방식이 곧 입력값이면
 * 유도가 사라지고, 부호도 방식에서 자동으로 나온다(수취 −, 발행 +).
 *
 * 부수 효과로 **통과 항목의 특수 케이스가 사라진다** — 광고비는 한 행이 양쪽
 * 다리를 대표하는 게 아니라 **두 행**(브랜드사에서 받는 행 + 셀러에게 주는 행)
 * 이다. 실물 계산서가 실제로 두 장이므로 이쪽이 사실에 충실하고, 두 행을 잇는
 * 링크 필드는 **의도적으로 만들지 않는다** — 금액이 어긋나면 그것은 통과가
 * 아니라 마진이라, 링크가 있으면 그 사실을 도로 흐린다.
 */

import { calcIndividualIncomeTax, getSellerPayoutBase } from "./seller-tax-utils";

/** 계산서 방식 — 값 정본. DB `CampaignSettlementItem.invoiceMode` 에 그대로 저장된다. */
export const SETTLEMENT_INVOICE_MODES = ["PURCHASE_RECEIVE", "SALES_ISSUE", "NO_INVOICE"] as const;
export type SettlementInvoiceMode = (typeof SETTLEMENT_INVOICE_MODES)[number];

/** 대상 — 값 정본. DB `CampaignSettlementItem.counterparty` 에 그대로 저장된다. */
export const SETTLEMENT_COUNTERPARTIES = ["BRAND", "SELLER", "INTERNAL"] as const;
export type SettlementCounterparty = (typeof SETTLEMENT_COUNTERPARTIES)[number];

/** 재무 카드의 3구간 — 항목이 어느 구간에 뜨는지는 **대상이 곧 정한다**. */
export type SettlementZone = "BRAND" | "SELLER" | "INTERNAL";

/** 판정에 필요한 사실만 — Prisma 모델을 그대로 끌고 오지 않는다(순수 유지). */
export type SettlementItemInput = {
  invoiceMode: string;
  counterparty: string;
  /** VAT 포함 금액. **부호 있는 값**(음수 = 역방향 정정). */
  amount: number;
};

/** 화면·API 가 주고받는 부가 항목 1건. */
export type SettlementItemRow = SettlementItemInput & {
  id: string;
  invoiceMode: SettlementInvoiceMode;
  counterparty: SettlementCounterparty;
  note: string | null;
  sortOrder: number;
};

export const SETTLEMENT_INVOICE_MODE_LABEL: Record<SettlementInvoiceMode, string> = {
  PURCHASE_RECEIVE: "매입 수취",
  SALES_ISSUE: "매출 발행",
  NO_INVOICE: "없음",
};

export const SETTLEMENT_COUNTERPARTY_LABEL: Record<SettlementCounterparty, string> = {
  BRAND: "브랜드",
  SELLER: "셀러",
  INTERNAL: "자사",
};

export function isSettlementInvoiceMode(value: string): value is SettlementInvoiceMode {
  return (SETTLEMENT_INVOICE_MODES as readonly string[]).includes(value);
}

export function isSettlementCounterparty(value: string): value is SettlementCounterparty {
  return (SETTLEMENT_COUNTERPARTIES as readonly string[]).includes(value);
}

/**
 * 대상이 자사면 계산서 방식은 **항상** `NO_INVOICE` 다 — 상대 없는 계산서는
 * 성립하지 않는다. UI 는 대상=자사 선택 시 방식을 자동 전환하고 비활성으로
 * 보여주며(오너 8차: 오류 문구보다 "만들 수 없게" 하는 쪽), 서버는 이 함수로
 * 한 번 더 정규화한다 — 클라이언트만 믿으면 API 직접 호출로 금지 조합이 들어온다.
 */
export function normalizeSettlementItemMode(
  counterparty: SettlementCounterparty,
  invoiceMode: SettlementInvoiceMode,
): SettlementInvoiceMode {
  return counterparty === "INTERNAL" ? "NO_INVOICE" : invoiceMode;
}

/** 이 항목이 뜨는 구간 — 대상이 곧 구간이다(읽기 모드에서 서브텍스트를 없앨 수 있는 근거). */
export function resolveSettlementZone(item: SettlementItemInput): SettlementZone {
  return item.counterparty === "BRAND" ? "BRAND" : item.counterparty === "SELLER" ? "SELLER" : "INTERNAL";
}

/**
 * 표시 금액(부호 포함) = **방식 기본 부호 × 입력 금액 부호**.
 *
 * - `SALES_ISSUE`(우리가 발행) → 우리가 받을 돈이므로 `+`
 * - `PURCHASE_RECEIVE`(상대가 발행) → 우리가 낼 돈이므로 `−`
 * - `NO_INVOICE` × 셀러 → 계산서 없이 지급하는 건(개인 셀러 원천징수 대상)이라 `−`
 * - `NO_INVOICE` × 자사 → 방식이 부호를 못 정하므로 **입력 금액의 부호가 곧 방향**
 *   (잡이익 +, 기타 비용 −)
 *
 * ⚠️ 입력 금액에 음수를 넣으면 방향이 뒤집힌다 — 이것은 버그가 아니라 **역방향
 * 정정**(수정세금계산서·반품 조정 차감)을 담는 의도된 통로다. 실측에서 부호가
 * 반대인 차감 건이 관측됐고(`expected-receivables.ts` 의 수기 물품대금 주석),
 * 그때 별도 필드를 만들지 않고 부호로 표현하기로 했다(오너 8차).
 */
export function resolveSettlementItemSignedAmount(item: SettlementItemInput): number {
  const amount = Number(item.amount) || 0;
  if (item.counterparty === "INTERNAL") return amount;
  return item.invoiceMode === "SALES_ISSUE" ? amount : -amount;
}

// ─────────────────────────────────────────────────────────────────────────────
// 계산서에 실리는 항목 고르기 (2-A) — 설계 §9-2·§9-4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 「어느 계산서에 실리는가」를 가리키는 축.
 *
 * 의무 축(`direction × counterpart`, `tax-filing-board.ts`)과 이 축은 **같은 사실의
 * 같은 표현**이다 — `SALES_ISSUE` = 우리가 발행(ISSUE), `PURCHASE_RECEIVE` = 상대가
 * 발행(RECEIVE), `BRAND` = 공급사(SUPPLIER), `SELLER` = 셀러. 그래서 반영 규칙에
 * **방향을 다시 유도하는 코드가 없다**(설계 §9-2 — 1단계가 저장 축을 「계산서 방식 ×
 * 대상」으로 고른 결정의 이자다).
 *
 * ⛔ `NO_INVOICE` 와 `INTERNAL` 은 **타입 수준에서** 이 축이 될 수 없다. 계산서가
 * 없는 돈을 계산서 금액에 더하는 것은 모순이고, 그 금지를 런타임 조건문이 아니라
 * 타입으로 두면 새 호출부가 실수로 넣을 수 없다.
 *
 * ⚠️ 이 축과 `AmountBasis` 의 대응표는 **여기 두지 않는다** — 그 표는 의무가 무엇인지
 * 아는 쪽(`tax-filing-board.ts`)의 지식이고, 이 파일은 순수·client-safe 를 유지해야
 * 해서 그쪽을 import 할 수 없다(순환도 생긴다).
 */
export type SettlementItemInvoiceAxis = {
  invoiceMode: Extract<SettlementInvoiceMode, "PURCHASE_RECEIVE" | "SALES_ISSUE">;
  counterparty: Extract<SettlementCounterparty, "BRAND" | "SELLER">;
};

/**
 * 그 계산서에 실리는 부가 항목만 고른다. 축이 `null`(= 이 의무는 부가 항목을 받지
 * 않는다)이면 빈 배열.
 *
 * 호출부가 **개수·품목명·합계를 전부** 필요로 하므로(배지 문구 · XLSX 품목 행 ·
 * 기대액) 합계 함수가 아니라 목록 함수를 1차 원시로 둔다 — 같은 필터를 세 번 쓰면
 * 그중 하나가 갈린다.
 */
export function collectSettlementItemsOnInvoice<T extends SettlementItemInput>(
  items: readonly T[] | null | undefined,
  axis: SettlementItemInvoiceAxis | null,
): T[] {
  if (!items || axis === null) return [];
  return items.filter(
    (item) => item.invoiceMode === axis.invoiceMode && item.counterparty === axis.counterparty,
  );
}

/**
 * 그 계산서에 **얹히는 금액**(VAT 포함)의 합.
 *
 * ⛔ `resolveSettlementItemSignedAmount`(재무 카드의 입금↓/지급↑ 부호)를 재사용하지
 * **말 것.** 두 함수는 다른 질문에 답한다:
 *
 * - `resolveSettlementItemSignedAmount` = 「우리 통장에서 나가나 들어오나」 — 재무
 *   카드의 방향색·구간 합계가 쓰는 어휘다.
 * - 이 함수 = 「이 종이(계산서)에 얼마가 적히나」 — 방식이 이미 **어느 계산서인지**를
 *   정했으므로, 그 계산서 안에서 항목은 언제나 양의 방향으로 얹힌다.
 *
 * 그래서 여기서는 `amount` 를 **그대로**(부호 포함) 더한다. 음수 입력은 계산서 금액을
 * 줄이는데, 그것이 1단계가 만든 **역방향 정정**(수정세금계산서·반품 조정 차감)의
 * 의도된 통로다.
 *
 * 두 축을 한 함수로 합치려는 유혹이 이 트랙의 반복 실패다 — 1단계 교차 검증이 잡은
 * 「판정을 손으로 재구현」 사고가 정확히 그 형태였다(설계 §9-4).
 */
export function sumSettlementItemsOnInvoice(
  items: readonly SettlementItemInput[] | null | undefined,
  axis: SettlementItemInvoiceAxis | null,
): number {
  return collectSettlementItemsOnInvoice(items, axis).reduce(
    (sum, item) => sum + (Number(item.amount) || 0),
    0,
  );
}

/** 구간별로 항목을 나눈다 — 화면 3구간이 각자 자기 목록만 렌더한다. */
export function groupSettlementItemsByZone<T extends SettlementItemInput>(
  items: readonly T[],
): Record<SettlementZone, T[]> {
  const grouped: Record<SettlementZone, T[]> = { BRAND: [], SELLER: [], INTERNAL: [] };
  for (const item of items) grouped[resolveSettlementZone(item)].push(item);
  return grouped;
}

/** 구간 합계(부호 포함). 빈 배열이면 0 — 「없음」과 「0원」이 같은 뜻인 자리다. */
export function sumSettlementItems(items: readonly SettlementItemInput[]): number {
  return items.reduce((sum, item) => sum + resolveSettlementItemSignedAmount(item), 0);
}

/**
 * 셀러에게 **지급**하는 부가 항목의 세전 합.
 *
 * ⛔ 이 값은 셀러 정산 **기준액**이 아니다 — 기준액은 `actualSales × 셀러수수료율`
 * 하나뿐이고 이 합은 「지급 총액」에만 더해진다(불변식). 원천징수 대상 개인 셀러는
 * 이 합까지 포함해 3.3% 를 **한 줄로 합산 공제**한다(오너 3차: 항목별 세후 표기를
 * 하면 실제 이체할 원천세 합계를 어디서도 못 읽는다).
 *
 * 대상=셀러인데 `SALES_ISSUE`(우리가 셀러에게 청구) 인 드문 행은 지급이 아니라
 * 수취라 부호가 +이므로, 합계에 그대로 더하면 지급액이 **줄어드는** 것이 맞다.
 */
export function sumSellerPayoutItems(items: readonly SettlementItemInput[]): number {
  const sellerItems = items.filter((item) => item.counterparty === "SELLER");
  // 지급은 음수로 나오므로 부호를 뒤집어 "지급액" 이라는 양수 어휘로 돌려준다.
  return -sumSettlementItems(sellerItems);
}

/**
 * 「정산 기준액」 — **판매대행비를 계산할 때 곱하는 매출액**과 그 이름을 함께 낸다
 * (오너 정정 2026-08-27: 정산 기준액은 곱한 결과가 아니라 곱하는 대상이다).
 *
 * ⚠️ 기준은 세무 유형이 가른다 — 개인은 공급가액(부가세 제외), 사업자는 총 거래액.
 * 그래서 「총 거래액 × 셀러수수료율」이라는 종전 설명은 개인 셀러에게 사실이 아니었다.
 *
 * **금액과 이름을 한 함수가 함께 돌려주는 것이 요점이다** — 갈라 두면 화면이 공급가액을
 * 찍으면서 「총 거래액」이라고 말하는 상태가 다시 만들어진다. 화면은 판정 함수를 직접
 * 부를 수 없다(계약 `settlement-statement-text.test.ts` — 기준·세율 계산은 lib 소관).
 */
export function resolveSellerFeeBasis(
  actualSales: number,
  isIndividual: boolean,
): { amount: number; label: string } {
  return {
    amount: getSellerPayoutBase(actualSales, isIndividual),
    // 꼬리의 「부가 항목 무관」은 화면의 「고정」 태그가 무엇에 대해 고정인지를 말한다 —
    // 종전 도움말이 그 설명을 달고 있었고, 빼면 태그가 이유 없이 붙은 것으로 읽힌다
    // (ss-ux 검토 P1).
    // ⚠️ 길이도 계약이다 — 이 문구가 들어가는 자리(`FinancialLine` 의 hint)는 한 줄
    // 말줄임이고 데스크톱 실측 폭이 272px 다. 늘리기 전에 실렌더로 재보라(현재 약 229px).
    label: isIndividual
      ? "공급가액(총 거래액 ÷ 1.1) · 부가 항목 무관"
      : "총 거래액 · 부가 항목 무관",
  };
}

/**
 * 브랜드사 정산 총액(화면 라벨은 부호에 따라 「지급할/받을 총액」)에 더해지는
 * 부가 항목 합(부호 포함).
 * 물품대금·영업수익 등 기존 항목은 호출부가 더한다 — 이 함수는 부가 항목만 본다.
 */
export function sumBrandItems(items: readonly SettlementItemInput[]): number {
  return sumSettlementItems(items.filter((item) => item.counterparty === "BRAND"));
}

/**
 * 자사 손익에 직접 기록되는 항목 합(잡이익 +, 기타 비용 −).
 */
export function sumInternalItems(items: readonly SettlementItemInput[]): number {
  return sumSettlementItems(items.filter((item) => item.counterparty === "INTERNAL"));
}

/**
 * 브랜드사에 **지급**한 부대비용의 합(양수로 반환) — 자사 손익의 조정 근거 1줄.
 *
 * ⚠️ 오너 4차 지적("자사손익에는 현금 수취 내역만 있어야 상계 아닌가")의 검토
 * 결과가 이 함수다: **상계가 성립하려면 조정 후 손익에 양쪽 다리가 다 들어가야
 * 한다.** 반품배송비를 브랜드사에 내고(−) 소비자에게 현금으로 받았다면(+),
 * 잡이익만 더하면 그 비용만큼 손익이 **과대표시**된다 — 저장 `operatingProfit`
 * 에는 이 비용이 반영돼 있지 않기 때문이다. 편집·소유는 브랜드사 구간 한 곳이고
 * 자사 손익에는 muted 참조 1줄로만 뜬다(A안, 오너 11차 확정).
 */
export function sumBrandPaidItems(items: readonly SettlementItemInput[]): number {
  const paid = items.filter(
    (item) => item.counterparty === "BRAND" && resolveSettlementItemSignedAmount(item) < 0,
  );
  return -sumSettlementItems(paid);
}

/**
 * 조정 후 손익 = 저장 영업이익 − (브랜드사 지급 부대비용) + (자사 기록 항목).
 *
 * ⛔ 저장 `operatingProfit` 을 이 값으로 덮어쓰지 않는다 — `isManual*` 오버라이드
 * 체계와 기존 106건과의 비교 가능성이 흔들린다. 파생 SSOT 는 불변이고 조정은
 * 표시 계층에서만 한다(설계 §4-3).
 */
export function resolveAdjustedOperatingProfit(
  operatingProfit: number,
  items: readonly SettlementItemInput[],
): number {
  return operatingProfit - sumBrandPaidItems(items) + sumInternalItems(items);
}

/** 부가 항목이 손익 조정을 만드는가 — 「조정 후 손익」 병기 여부를 이걸로 가른다. */
export function hasProfitAdjustment(items: readonly SettlementItemInput[]): boolean {
  return sumBrandPaidItems(items) !== 0 || sumInternalItems(items) !== 0;
}

/**
 * 셀러 구간의 표시 금액 3종 — **원천세 계산이 화면에 흩어지지 않게** 여기서 한다.
 *
 * 재무 카드와 셀러 명세서가 같은 규칙을 써야 한다: 판매대행비와 셀러 지급 부가 항목을
 * **합산해 한 줄로** 3.3% 를 공제한다(오너 확정 — 항목별 세후 표기를 하면 오너가 실제로
 * 이체할 원천세 합계를 어디서도 읽을 수 없다).
 *
 * ⛔ 화면(`campaign-side-panel.tsx` 등)이 `calcIndividualIncomeTax` 를 직접 부르지 않는다 —
 * `settlement-statement-text.test.ts` 가 그 금지를 소스 스캔으로 고정한다(세율이 화면마다
 * 갈리면 명세서와 카드가 다른 금액을 말한다).
 *
 * ⚠️ `sellerBaseAmount`(판매대행비)는 **불변식의 결과값**이지 이 함수가 정하는 값이 아니다 —
 * 부가 항목은 이 기준을 건드리지 않고 지급 총액에만 더해진다.
 */
export function resolveSellerZoneTotals(input: {
  /**
   * 판매대행비(세전) = **기준 매출액** × 셀러수수료율.
   * ⚠️ 기준 매출액은 `actualSales` 그 자체가 아니다 — 세무 유형이 가른다
   * (개인=공급가액 · 사업자=총 거래액). 판정은 `resolveSellerFeeBasis` 가 소유한다.
   */
  sellerBaseAmount: number;
  items: readonly SettlementItemInput[];
  isIndividual: boolean;
}): {
  /** 셀러 지급 부가 항목 세전 합. */
  itemsPayout: number;
  /** 대행비 + 부가 항목 **합산** 원천세(사업자면 0). */
  withholdingTax: number;
  /** 셀러가 실제로 받는 총액. */
  payoutTotal: number;
} {
  const itemsPayout = sumSellerPayoutItems(input.items);
  const withholdingTax = input.isIndividual
    ? calcIndividualIncomeTax(input.sellerBaseAmount + itemsPayout)
    : 0;
  return {
    itemsPayout,
    withholdingTax,
    payoutTotal: input.sellerBaseAmount + itemsPayout - withholdingTax,
  };
}
