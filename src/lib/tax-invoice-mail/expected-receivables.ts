/**
 * 채널별 **수취(우리가 받는)** 세금계산서 기대 건 생성 — 순수 함수.
 *
 * 정본은 `docs/private/specs/2026-08-03-tax-filing-helper-design.md` 의
 * 「채널별 세금계산서 거래 구조」 절(오너 확정 2026-08-03)이다.
 *
 * | 채널 | `supplierInvoiceIssuedAt` | `sellerInvoiceIssuedAt` |
 * | --- | --- | --- |
 * | 우리몰(OWN_MALL*) | **수취** ← 공급사 (물품 대금) | **수취** ← 셀러 (수수료) |
 * | 브랜드몰(BRAND_MALL) | **발행** → 공급사 (수취 아님) | **수취** ← 셀러 (수수료) |
 * | 셀러몰(그 외 전부) | **수취** ← 공급사 (물품 대금) | **발행** → 셀러 (수취 아님) |
 *
 * ✅ **2026-08-07 오너 정정 이후 전 채널이 「필드명 = 상대」로 균일하다** —
 * `supplierInvoiceIssuedAt` 은 항상 공급사, `sellerInvoiceIssuedAt` 은 항상 셀러이고,
 * 채널이 바꾸는 것은 방향뿐이다. "필드 이름이 상대를 뜻하지 않는다"던 종전 경고는
 * 폐기됐다(정정 근거는 `tax-filing-board.ts`의 `TAX_INVOICE_OBLIGATION_TABLE` 헤더
 * 주석·`docs/private/specs/2026-08-07-settlement-invoice-direction-design.md` §2).
 *
 * ✅ 셀러몰의 「공급사 → 우리 물품비 수취」도 같은 정정으로 추적 슬롯이 생겼다 — 이제
 * 우리몰·브랜드몰과 같은 `supplierInvoiceIssuedAt` 을 쓴다(아래 `SELLER_MALL` 분기 참조).
 * 종전엔 체크리스트에 대응 항목이 없어 `trackingField: null` 로 버렸으나 그 제약은
 * 사라졌다.
 *
 * ## 정산 그룹 — `buildGroupExpectedReceivables`(오너 확정 2026-08-04)
 *
 * 「셀러·공급사 둘 다 그룹당 한 장을 합산해서 끊는다」(설계 문서
 * `2026-08-03-tax-invoice-receipt-mail-engine.md`의 「✅ 정산 그룹의 계산서 장수 —
 * 확정」절). 위 `buildExpectedReceivables`는 캠페인 1건만 본다 — 그룹 정산에서 그걸
 * 그대로 캠페인별로 쓰면 어느 캠페인의 기대액도 실제 계산서 총액(그룹 합산분)과 맞지
 * 않아 그룹 건이 영구히 `AMOUNT_MISMATCH`로 떨어진다(기능이 조용히 그룹을 비껴간다 —
 * 이번 정정의 계기). `buildGroupExpectedReceivables`가 그룹 인지형 진입점이다 — 멤버가
 * 1건(미그룹)이면 위 함수로 그대로 위임한다.
 */

import { isIndividualSeller } from "../seller-tax-utils";
import {
  GOODS_COST_FORMULA_BASIS,
  GOODS_COST_MANUAL_BASIS,
  resolveGoodsCost,
} from "../goods-cost";
import { sumSettlementItemsOnInvoice, type SettlementItemInput } from "../settlement-items";
import { resolveAddableItemAxis } from "../tax-filing-board";

/** 채널 판정 3분류. 반드시 `campaign-checklist.ts` 와 **같은 분기**여야 보드 행과 1:1로 맞는다. */
export type SalesChannelKind = "OWN_MALL" | "BRAND_MALL" | "SELLER_MALL";

/**
 * `salesChannel` 6종(`UNSPECIFIED`·`OWN_MALL`·`OWN_MALL_NAVER`·`OWN_MALL_KAKAO`·
 * `SELLER_MALL`·`BRAND_MALL`)을 3분류로 접는다.
 *
 * `UNSPECIFIED` 가 셀러몰로 떨어지는 것은 **기존 동작**이다 — 다르게 판정하면 매칭되는
 * 체크리스트 항목이 없어 「완료」를 누를 수 없는 행이 생긴다.
 */
export function resolveChannelKind(salesChannel: string | null | undefined): SalesChannelKind {
  const value = salesChannel ?? "";
  if (value.startsWith("OWN_MALL")) return "OWN_MALL";
  if (value === "BRAND_MALL") return "BRAND_MALL";
  return "SELLER_MALL";
}

/** 수취 건의 종류. 상대가 누구인가로 가른다(필드 이름이 아니라). */
export type ReceivableSlot = "SELLER_COMMISSION" | "SUPPLIER_GOODS";

/** 대조에 필요한 캠페인 사실만 담는다 — Prisma 모델을 그대로 끌고 오지 않는다(순수 유지). */
export interface CampaignSettlementFacts {
  campaignId: string;
  /** 표시용 라벨. 셀러 실명이 들어올 수 있으므로 **추적 파일·로그에 남기지 않는다**(P0). */
  campaignLabel: string;
  salesChannel: string | null;
  /** 총 매출(VAT 포함) */
  actualSales: number | null;
  /** 영업수익 = 매출 × RS% (VAT 포함) */
  settlementSales: number | null;
  /** 셀러 수수료 = 매출 × 셀러수수료% (VAT 포함) */
  sellerExpense: number | null;
  /**
   * **수기 물품대금** = 이 캠페인 앞으로 온 **매입 계산서의 합계금액**(VAT 포함).
   * 있으면 아래 공식보다 **우선**한다 — 오너가 정산내역서에서 그대로 옮겨 적는 관측값이다.
   *
   * ⛔ 이 주석의 근거가 되는 실측 수치·상호·캠페인 좌표는 **모드 L 워크시트**
   * (`docs/handoff/payout-date-backfill-worklist.md` 부록2, git 미추적)에만 둔다 —
   * 레포가 public 이라 여기 싣는 순간 공개다(P0). 아래는 구조만 남긴 요약이다.
   *
   * ## ⚠️ "캠페인의 원가"가 아니다 — 계산서는 캠페인 경계와 어긋난다
   *
   * 이 값은 캠페인 매출과 1:1로 대응하지 **않을 수 있다**. 실측·오너 확인된 두 형태(2026-08-06):
   * - **자체 판매분이 계산서에 포함된다.** 우리가 직접 판 수량을 공급사와의 거래에 특정
   *   캠페인 건으로 포함시켜 끊고, 셀러 정산금액을 맞추려 공급가격을 조정하는 운영이
   *   실재한다(예외적, 오너 확인). 그런 건의 마진율은 실제 공급률의 거울이 아니라
   *   **운영상 조정된 값**이다.
   * - **한 장이 여러 캠페인·여러 셀러를 묶는다.** 서로 다른 두 셀러의 그룹을 합산해 발행된
   *   계산서 1장이 실측됐다.
   *
   * ⛔ **그래서 이 값을 손익·원가 계산에 쓰지 말 것.** 세무 대조(실물 계산서와의 대사) 전용이다.
   *   손익에 흘리면 자체 판매분이 그 캠페인 원가로 잡힌다. 소비처 확대는 오너 승인 사안이고
   *   `expected-receivables-scope.contract.test.ts` 가 소스 스캔으로 막는다.
   *
   * ## 왜 공식을 못 믿나 (실물 매입계산서 원 단위 대조, 2026-08-06)
   *
   * 공식(`총매출 − 영업수익`)이 실물과 정확히 맞은 표본은 소수였고 나머지는 1% 미만
   * 범위에서 **양쪽 부호로** 어긋났다. 원인이 하나가 아니다 — 계산서 범위가 캠페인보다
   * 넓은 건, 반품 조정으로 보이는 차감 건(부호가 반대라 부속 라인으로 설명되지 않는다),
   * 원인 미상 건. 근본적으로 **`totalMarginRate` 는 공급률의 거울이 아니라 운영 레버**라
   * 공식이 실물을 재현할 수 없다.
   *
   * ⛔ **허용오차로 덮지 않는다.** 비율은 작아도 캠페인 금액 규모에서 허용 폭이 십만원대가
   * 되는데, 수취 대조 실측에서 허용오차를 그 규모로 키우면 단일 특정이 줄고 모호 건이
   * 생기는 것이 확인됐다(수치는 위 워크시트).
   *
   * ⛔ **부속 라인(공급률 100% 품목) 모델링으로 대체하지 말 것** — 어긋난 표본 대부분을
   * 설명하지 못한다.
   *
   * ## `0` = 「다른 캠페인의 계산서에 합산됨」 — 기대 건을 만들지 않는다
   *
   * 오너 확정(2026-08-06): 자체 판매분은 최근 **별도 셀러의 캠페인을 따로 만들어** 집계하되,
   * 브랜드사와는 1건의 거래라 **계산서는 두 캠페인 합산 금액으로 1장**이 발행된다. 그 부속
   * 캠페인에 공식 폴백을 태우면 존재하지 않는 두 번째 계산서를 영원히 기다리는 유령
   * 기대건이 된다.
   *
   * 0원짜리 세금계산서는 실무상 존재하지 않으므로 `0` 을 「받을 계산서 없음(합산 이관)」
   * 마커로 쓴다 — **총액은 주 캠페인에, 0 은 합산된 쪽에** 입력한다. 주 캠페인의 수기값이
   * 합산 총액이므로 실물 1장과 정확히 맞는다.
   *
   * ⚠️ 그룹을 **넘는** 한 장(두 그룹 합산 발행)은 이 필드로도 못 닫는다 — 총액을 어느
   * 그룹에 적어도 나머지 그룹이 공식 폴백으로 유령 기대건을 만든다. 그쪽 그룹 멤버 전원에
   * 0 을 넣고 총액을 주 그룹에 넣으면 닫힌다(위 마커의 그룹 확장).
   *
   * `null` 은 "0원"이 아니라 **미입력**이다. 그때만 공식으로 폴백한다.
   * (미입력 → 공식 / 0 → 기대 없음 / 양수 → 그 금액. 세 상태가 전부 다르다.)
   */
  manualGoodsCost?: number | null;
  /**
   * 정산 **부가 항목** — 실물 계산서에 품목 행으로 함께 실리는 돈(설계 §9-2).
   *
   * 기대액에 어떻게 작용하는지는 `AMOUNT_BASIS_ITEM_RULE`(`tax-filing-board.ts`)이
   * 정한다 — 여기서 방향을 다시 유도하지 않는다. 물품대금 슬롯은 **가산 대상이
   * 아니다**(§9-3: 매입 부대비용은 물품대금 계산서에 이미 합산돼 온다).
   *
   * ⚠️ 미지정(undefined)과 0건([])은 같은 뜻이다 — 부가 항목은 「평소 0행이 정상」이라
   * 없음이 곧 0원이고, `manualGoodsCost` 처럼 「모름 → 폴백」으로 해석하지 않는다.
   */
  settlementItems?: SettlementItemInput[];
  /** 셀러의 사업자등록번호(개인 셀러면 null — 계산서 자체가 없다) */
  sellerBusinessNumber: string | null;
  /**
   * 셀러 과세 구분(`INDIVIDUAL`·`BUSINESS`·미지정). **보드와 같은 규칙으로** 개인 셀러를
   * 가르는 데만 쓴다 — 개인 셀러는 계산서가 아니라 원천징수 대상이라 수취 기대 건 자체가
   * 성립하지 않는다. 판별은 `seller-tax-utils.isIndividualSeller` 하나로 한다(재구현 금지 —
   * 규칙이 갈리면 보드엔 없는 행이 미수취 목록에만 뜬다).
   */
  sellerTaxType?: string | null;
  sellerLabel: string;
  /** 공급사(거래처)의 사업자등록번호 */
  partnerBusinessNumber: string | null;
  partnerLabel: string;
  /** 이미 수취 완료로 기록된 시각(ISO). 있으면 판정은 하되 미처리 목록에서 뺄 수 있다. */
  supplierInvoiceIssuedAt: string | null;
  sellerInvoiceIssuedAt: string | null;
  /** 작성일자 타당성 창(선택). 없으면 날짜 검사를 건너뛴다. */
  validWrittenDateFrom?: string | null;
  validWrittenDateTo?: string | null;
}

export interface ExpectedReceivable {
  /** `campaignId:slot` — 판정 결과를 캠페인으로 되돌리는 키 */
  key: string;
  campaignId: string;
  campaignLabel: string;
  slot: ReceivableSlot;
  channel: SalesChannelKind;
  /** 계산서를 **발행하는 쪽**(= 우리 상대)의 사업자등록번호 */
  counterpartBusinessNumber: string | null;
  counterpartLabel: string;
  /**
   * 기대 금액(**VAT 포함 합계**). `null` 은 "0원"이 아니라 **기준 미확정**이다 —
   * 우리몰 공급사 물품대금이 그 경우이고, 추측한 숫자를 띄우면 오너가 그 값으로 대사(對査)하게
   * 된다(이 설계가 이미 한 번 낸 사고).
   */
  expectedTotalAmount: number | null;
  /** 금액의 근거를 사람이 읽을 수 있게 남긴다(미확정 사유 포함). */
  amountBasis: string;
  /**
   * 기대액이 **수기 입력값**에서 왔는가(= 공식 폴백이 아닌가).
   *
   * ⛔ 호출부는 이 불리언으로 판정하고 `amountBasis` 문자열을 파싱하지 말 것 — 문구를
   * 다듬는 순간 조용히 판정이 뒤집힌다(이 레포가 감사 로그 `content` 파싱에서 이미 막은 부류).
   */
  amountIsManual: boolean;
  /**
   * 이 기대액이 **실물을 재현하지 못하는 추정**인가.
   *
   * ⛔ `!amountIsManual` 과 **같지 않다.** 셀러 수수료 슬롯도 `amountIsManual: false`
   * 인데(수기 물품대금은 물품비 전용이라 덮지 않는다) 그 값은 추정이 아니라 요율에서
   * 나온 **파생 확정값**이다. 두 필드를 같은 뜻으로 쓰면 셀러 수수료의 진짜 금액
   * 불일치가 「추정이라 어쩔 수 없다」로 덮인다.
   *
   * `true` 인 조합은 **공급사 물품대금 × 수기 미입력** 하나뿐이다. 그 공식
   * (`총매출 − 영업수익`)은 실물과 자주 어긋난다는 것이 이미 실측으로 확정됐고
   * (`manualGoodsCost` 주석), 그 어긋남은 **계산서가 틀린 것이 아니라 우리 추정이
   * 못 맞추는 것**이다. 그래서 판정이 그 둘을 다른 말로 해야 한다(`receipt-match.ts`
   * 의 `EXPECTED_AMOUNT_ESTIMATED`).
   *
   * 실측 근거(2026-08-08, 홈택스 20개월): 우리몰 공급사 매입계산서는 **상품별·월별**로
   * 끊겨 캠페인 경계와 아예 정렬되지 않는다. 그룹 판정 불능 7건이 전부 이 축이었다.
   */
  amountIsEstimate: boolean;
  /** 완료를 기록할 기존 필드. 셀러몰 물품비 수취는 자리가 없어 null. */
  trackingField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt" | null;
  /** 이미 완료로 기록됐는가 */
  alreadyMarkedAt: string | null;
  validWrittenDateFrom: string | null;
  validWrittenDateTo: string | null;
}

/**
 * 물품대금 기대액을 정한다 — 판정은 **공유 SSOT**(`goods-cost.ts`)에 위임한다.
 *
 * (종전 이 자리의 지역 `subtract` 는 SSOT 로 옮겨갔다 — 뺄셈에서 null 을 0 으로 치지
 * 않는 규칙이 그 함수의 핵심이라 판정과 같은 파일에 있어야 한다.)
 *
 * ⛔ 여기서 3-상태 판정을 다시 쓰지 말 것: 이 엔진과 세무 처리 보드가 같은 필드를
 * 다르게 읽던 **이중 기준**이 그 SSOT 를 만든 이유다(설계 §1-4·§3-1). 두 화면이 같은
 * 의무에 다른 금액을 말하면 오너는 어느 쪽을 홈택스에 넣을지 알 수 없다.
 */
function resolveGoodsCostForFacts(facts: CampaignSettlementFacts): {
  amount: number | null;
  basis: string;
  isManual: boolean;
  /** `0` 마커 — 이 캠페인의 물품대금은 다른 캠페인의 계산서에 합산됐다(기대 건 억제). */
  consolidatedAway: boolean;
} {
  const resolved = resolveGoodsCost({
    manualGoodsCost: facts.manualGoodsCost,
    actualSales: facts.actualSales,
    settlementSales: facts.settlementSales,
  });

  if (resolved.kind === "CONSOLIDATED") {
    return { amount: null, basis: GOODS_COST_MANUAL_BASIS, isManual: true, consolidatedAway: true };
  }
  if (resolved.kind === "MANUAL") {
    return { amount: resolved.amount, basis: GOODS_COST_MANUAL_BASIS, isManual: true, consolidatedAway: false };
  }
  return {
    amount: resolved.amount,
    basis: GOODS_COST_FORMULA_BASIS,
    isManual: false,
    consolidatedAway: false,
  };
}

/**
 * 한 캠페인에서 **우리가 수취할** 세금계산서 기대 건을 만든다.
 * 발행(우리가 끊는) 건은 포함하지 않는다 — 이 엔진의 대상이 아니다.
 */
export function buildExpectedReceivables(
  facts: CampaignSettlementFacts,
): ExpectedReceivable[] {
  const channel = resolveChannelKind(facts.salesChannel);
  const goods = resolveGoodsCostForFacts(facts);
  const base = {
    campaignId: facts.campaignId,
    campaignLabel: facts.campaignLabel,
    channel,
    validWrittenDateFrom: facts.validWrittenDateFrom ?? null,
    validWrittenDateTo: facts.validWrittenDateTo ?? null,
  };

  /**
   * ⛔ 개인 셀러면 셀러 수수료 수취 기대 건을 **만들지 않는다.**
   *
   * 보드(`tax-filing-board.ts`)는 같은 규칙으로 이 행을 이미 뺀다. 여기만 빠져 있어서,
   * 보드엔 존재하지도 않는 행이 「미수취 목록」에는 계속 떴다 — 게다가 상대 사업자번호가
   * null 이라 **어떤 계산서와도 영원히 매칭되지 않아** 지워지지도 않는 경보였다.
   * 두 화면이 서로 다른 말을 하면 오너는 둘 다 안 믿게 된다.
   */
  const sellerCommissionApplies = !isIndividualSeller({
    sellerTaxType: facts.sellerTaxType ?? null,
    sellerCompanyBusinessNumber: facts.sellerBusinessNumber,
  });

  /**
   * 셀러가 우리에게 끊는 수수료 계산서에는 「우리가 셀러에게 지급하는 부가 항목」이
   * 품목 행으로 **함께** 실린다(오너 확정, 설계 §3-3 — 별도 계산서 2건이 아니다).
   * 축은 보드의 `AMOUNT_BASIS_ITEM_RULE` 에서 빌려 온다(§9-2 SSOT).
   */
  const sellerCommissionItems = sumSettlementItemsOnInvoice(
    facts.settlementItems,
    resolveAddableItemAxis("SELLER_COMMISSION"),
  );

  const sellerCommission = (): ExpectedReceivable => ({
    ...base,
    key: `${facts.campaignId}:SELLER_COMMISSION`,
    slot: "SELLER_COMMISSION",
    counterpartBusinessNumber: facts.sellerBusinessNumber,
    counterpartLabel: facts.sellerLabel,
    // ⛔ `sellerExpense` 가 null 이면 **모름**이다 — 부가 항목만 더해 숫자를 만들면
    //    그 합이 계산서 총액인 것처럼 보이는 그럴듯한 오답이 된다(이 파일이 뺄셈에서
    //    이미 지킨 「누락을 0으로 치지 않는다」와 같은 원칙).
    expectedTotalAmount: facts.sellerExpense === null ? null : facts.sellerExpense + sellerCommissionItems,
    amountBasis:
      sellerCommissionItems === 0
        ? "셀러 수수료(sellerExpense) · VAT 포함"
        : `셀러 수수료(sellerExpense) + 셀러 지급 부가 항목 · VAT 포함(설계 §9-2)`,
    // 수기 물품대금은 **물품비 슬롯 전용**이다 — 셀러 수수료는 다른 금액이라 덮지 않는다.
    amountIsManual: false,
    // ⚠️ 그렇다고 추정인 것은 아니다 — 요율에서 나온 파생 확정값이라 실물과 어긋나면
    //    그건 진짜 불일치다(위 `amountIsEstimate` 주석).
    amountIsEstimate: false,
    trackingField: "sellerInvoiceIssuedAt",
    alreadyMarkedAt: facts.sellerInvoiceIssuedAt,
  });

  // 수기값 0 = 「다른 캠페인 계산서에 합산됨」 — 물품비 기대 건을 만들지 않는다(위
  // manualGoodsCost 주석). 셀러 수수료 슬롯은 영향받지 않는다 — 합산되는 것은 공급사
  // 물품대금 계산서이지 셀러 수수료 계산서가 아니다.
  const goodsRows = (): ExpectedReceivable[] =>
    goods.consolidatedAway
      ? []
      : [
          {
            ...base,
            key: `${facts.campaignId}:SUPPLIER_GOODS`,
            slot: "SUPPLIER_GOODS",
            counterpartBusinessNumber: facts.partnerBusinessNumber,
            counterpartLabel: facts.partnerLabel,
            // 채널 무관 공식은 오너 확정(2026-08-04)이지만 **실물과 자주 어긋난다**(위
            // `manualGoodsCost` 주석의 5건 실측) — 그래서 수기값이 있으면 그쪽이 정본이다.
            // 폴백 경로의 subtract()가 null 을 0 으로 치지 않으므로 settlementSales 가
            // 비어 있으면 "0원"이 아니라 그대로 null(모름)로 남는다.
            expectedTotalAmount: goods.amount,
            amountBasis: goods.basis,
            amountIsManual: goods.isManual,
            // 수기값이 없으면 공식 추정이고, 그 공식은 실물을 재현하지 못한다(확정 사실).
            amountIsEstimate: !goods.isManual,
            trackingField: "supplierInvoiceIssuedAt" as const,
            alreadyMarkedAt: facts.supplierInvoiceIssuedAt,
          },
        ];

  switch (channel) {
    case "OWN_MALL":
      return [...goodsRows(), ...(sellerCommissionApplies ? [sellerCommission()] : [])];

    case "BRAND_MALL":
      // supplierInvoiceIssuedAt 은 **발행**이므로 수취 기대 건이 아니다.
      return sellerCommissionApplies ? [sellerCommission()] : [];

    case "SELLER_MALL":
      // 2026-08-07 의무표 정정으로 추적 슬롯이 생겼다 — 종전엔 체크리스트에 대응 항목이
      // 없어 trackingField 를 null 로 덮었다(「추적할 자리가 아예 없는 상태」). 이제
      // 우리몰·브랜드몰과 같은 `supplierInvoiceIssuedAt` 을 쓴다.
      return goodsRows();
  }
}

/** null 이 하나라도 있으면 전체를 모름(null)으로 되돌린다 — 더하기라고 해서 missing
 *  operand 를 0으로 치지 않는다. 0으로 치면 "일부만 반영된 합계"가 "완전한 합계"처럼
 *  보이는 그럴듯한 오답이 된다(이 파일이 `subtract()`로 뺄셈 기준에서 이미 지킨 원칙과
 *  같다 — 연산 방향은 달라도 "누락을 0으로 취급하지 않는다"는 원칙 자체는 같다). */
function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** "YYYY-MM-DD" 문자열 비교 — 사전식 비교가 날짜 비교와 일치한다(고정 자릿수 형식). */
function extremeDateKey(
  values: readonly (string | null | undefined)[],
  pick: (a: string, b: string) => string,
): string | null {
  const known = values.filter((v): v is string => v != null);
  if (known.length === 0) return null;
  return known.reduce(pick);
}

/** `id.localeCompare` 오름차순 — `tax-filing-board.ts`(`emitGroupRows`)의 대표(anchor)
 *  선택 규칙과 **동일하게** 고정한다. 두 모듈이 같은 그룹을 같은 대표로 가리켜야
 *  `board-evidence.ts`의 조인이 anchor 키로 그룹 합산 여부를 판별할 수 있다. */
function sortByCampaignId(members: readonly CampaignSettlementFacts[]): CampaignSettlementFacts[] {
  return [...members].sort((a, b) => a.campaignId.localeCompare(b.campaignId));
}

function isUniform(values: readonly (string | null)[]): boolean {
  return new Set(values).size <= 1;
}

/**
 * 정산 그룹의 기대 수취 건 — 그룹 인지형 진입점(스펙 「✅ 정산 그룹의 계산서 장수 —
 * 확정」절). 멤버가 1건(미그룹 캠페인)이면 `buildExpectedReceivables`로 그대로
 * 위임한다 — 이 함수가 그룹·미그룹 양쪽을 다 받는 유일한 입구다.
 *
 * | 상황 | 기대 건 |
 * | --- | --- |
 * | 그룹 · 상대가 전 멤버 동일 | **그룹 1건**(금액 = 멤버 합산) |
 * | 그룹 · 상대가 갈림(공급사 다중) | **캠페인별**(현행 동작) — 이 슬롯만 후퇴 |
 * | 미그룹 | 캠페인별 |
 *
 * ## 왜 슬롯 단위로 후퇴하는가 — `tax-filing-board.ts`(`emitGroupRows`)와의 차이
 *
 * 셀러 상대(`SELLER_COMMISSION`)는 `CampaignGroup.sellerId`가 앱 레벨 불변식이라
 * 그룹 내 셀러가 항상 동일함이 보장된다 — 그래서 상대 불일치 가드가 필요 없고 **항상**
 * 합산한다. 공급사 상대(`SUPPLIER_GOODS`)는 그런 불변식이 없다(`dealId`는 멤버마다
 * 자유롭게 다를 수 있다) — 공급사가 그룹 전체에 물리적으로 한 장을 끊는 게 불가능한
 * 조합이면 그 슬롯만 캠페인별로 후퇴한다.
 *
 * `tax-filing-board.ts`의 `emitGroupRows`는 이 판정을 **행 전체**(두 슬롯 다) 단위로
 * 한다 — 공급사가 갈리면 셀러 쪽 행도 함께 캠페인별로 되돌린다. 이 함수는 스펙 표가
 * 명시한 대로 **슬롯 단위**로 더 세밀하게 후퇴한다("셀러 상대는 항상 합산 가능하다"는
 * 스펙 문장을 그대로 따른 결과) — 두 모듈이 이 축에서 다르게 판단한다. 그 결과 공급사
 * 상대가 갈리는 그룹에서 보드는 셀러 의무까지 캠페인별 행으로 쪼개 보여주는데, 이
 * 엔진은 그 셀러 의무를 여전히 그룹 1건으로 합산해 갖고 있다 — `board-evidence.ts`
 * 헤더 주석의 "알려진 불일치"가 이 차이를 다룬다. 여기서 board 쪽 동작을 따라 셀러도
 * 후퇴시키지 않은 이유는, 스펙이 "셀러 상대는 항상 합산 가능하다"고 **확정** 문장으로
 * 적었기 때문이다 — 확정된 사실을 board의 보수적 선택에 맞추려고 다시 흐리지 않는다.
 *
 * ## 채널이 그룹 안에서 갈리는 경우(스펙 표에 없는 축)
 *
 * `CampaignGroup`은 셀러만 고정하고 `salesChannel`은 캠페인마다 다를 수 있다. 채널이
 * 갈리면 어떤 slot이 존재하는지·금액 공식 자체가 채널마다 다르므로(예:
 * `resolveChannelKind`가 다르면 `buildExpectedReceivables`가 내는 slot 조합이 다르다)
 * 그룹을 의무 하나로 정의할 수 없다 — `tax-filing-board.ts`의 `CHANNEL_MISMATCH`
 * 가드와 같은 판단으로, 조용히 하나를 고르지 않고 **그룹 전체**(두 슬롯 다)를
 * 캠페인별로 되돌린다.
 */
export function buildGroupExpectedReceivables(
  members: readonly CampaignSettlementFacts[],
): ExpectedReceivable[] {
  if (members.length === 0) return [];
  if (members.length === 1) return buildExpectedReceivables(members[0]);

  const channels = new Set(members.map((m) => resolveChannelKind(m.salesChannel)));
  if (channels.size > 1) {
    return sortByCampaignId(members).flatMap((m) => buildExpectedReceivables(m));
  }

  const sorted = sortByCampaignId(members);
  const anchor = sorted[0];

  // 작성일자 타당 창은 멤버 전원의 캠페인 기간을 아우른다 — 그룹을 대표하는 실제
  // 계산서 1장은 어느 멤버의 캠페인 기간을 근거로 끊겼을지 알 수 없으므로, 가장 이른
  // 시작일 ~ 가장 늦은 종료일(+여유)까지로 창을 넓게 잡는다(좁히면 정상 건이 「확인
  // 필요」로 떨어진다 — route.ts의 WRITTEN_DATE_GRACE_DAYS 주석과 같은 원칙).
  const summed: CampaignSettlementFacts = {
    ...anchor,
    actualSales: sum(sorted.map((m) => m.actualSales)),
    settlementSales: sum(sorted.map((m) => m.settlementSales)),
    sellerExpense: sum(sorted.map((m) => m.sellerExpense)),
    // ⛔ **부분 합산 금지.** 멤버 하나라도 수기값이 비어 있으면 sum()이 null 을 돌려주고
    //    그룹 전체가 공식 폴백으로 간다. 입력된 멤버만 더하면 "일부만 반영된 합계"가
    //    실물 계산서 총액인 것처럼 보이는 그럴듯한 오답이 된다 — 그룹은 계산서 **한 장**이라
    //    그 오답이 곧 영구 AMOUNT_MISMATCH 이거나, 더 나쁘게는 우연히 근사해 오확정이 된다.
    //    ⚠️ anchor 스프레드가 대표 멤버의 값을 실어 오므로 여기서 **반드시** 덮어쓴다.
    manualGoodsCost: sum(sorted.map((m) => m.manualGoodsCost ?? null)),
    // ⚠️ anchor 스프레드가 **대표 멤버의 항목만** 실어 오므로 반드시 덮어쓴다(위
    //    `manualGoodsCost` 와 같은 함정). 다만 규칙은 정반대다: 물품대금은 한 명만
    //    비어도 전체가 공식으로 후퇴하는 반면, 부가 항목은 **미입력이 곧 0건**이라
    //    부분 합산 금지가 적용되지 않는다(설계 §9-5) — 그냥 전원을 이어 붙인다.
    settlementItems: sorted.flatMap((m) => m.settlementItems ?? []),
    validWrittenDateFrom: extremeDateKey(sorted.map((m) => m.validWrittenDateFrom), (a, b) => (a < b ? a : b)),
    validWrittenDateTo: extremeDateKey(sorted.map((m) => m.validWrittenDateTo), (a, b) => (a > b ? a : b)),
  };

  const merged = buildExpectedReceivables(summed).map((item) => ({
    ...item,
    amountBasis: `${item.amountBasis} · 정산 그룹 ${sorted.length}건 합산(그룹당 계산서 1장, 오너 확정 2026-08-04)`,
  }));

  const partnerUniform = isUniform(sorted.map((m) => m.partnerBusinessNumber));
  if (partnerUniform) return merged;

  // 공급사 상대가 갈린다 — SUPPLIER_GOODS 슬롯만 캠페인별로 후퇴한다(셀러 쪽은 위 합산
  // 결과를 그대로 둔다).
  return merged.flatMap((item) => {
    if (item.slot !== "SUPPLIER_GOODS") return [item];
    return sorted.flatMap((m) => buildExpectedReceivables(m).filter((mi) => mi.slot === "SUPPLIER_GOODS"));
  });
}
