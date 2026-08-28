// 월별 세금계산서 처리 보드 집계 계약 (2026-08-03, 채널별 거래 구조 정정판).
//
// 이전 버전은 「발행 = 우리→셀러, 수취 = 셀러→우리」로 단정한 잘못된 모델을 고정하고
// 있었다(오너 확정 사항과 불일치). 이 파일은 스펙
// `docs/private/specs/2026-08-03-tax-filing-helper-design.md` 의 「⛔ 채널별
// 세금계산서 거래 구조」 절을 기준으로 다시 쓴다 — 상대와 방향이 채널마다 다르고,
// `salesChannel.startsWith("OWN_MALL")`·`=== "BRAND_MALL"`·그 외(셀러몰) 3분기가
// `campaign-checklist.ts` 와 정확히 같아야 한다는 계약을 고정한다.
import { describe, it, expect } from "vitest";
import {
  buildTaxInvoiceObligationRows,
  computeBaseAmountForBasis,
  buildTaxInvoiceWorkBoard,
  resolveBoardSection,
  resolveCampaignInvoiceSlots,
  describeMoneySlotAmountBlock,
  resolveCampaignMoneySlots,
  resolveMoneySlotAmountDisplay,
  resolveMoneySlotDisplayAmount,
  resolveMoneySlotGroupFold,
  resolveMoneySlotEffectiveDate,
  resolveSettlementCompletionFlags,
  resolveSellerIssueInvoiceObligation,
  resolveTaxFilingChannelGroup,
  type CampaignMoneySlot,
  type TaxInvoiceBoardRow,
} from "../tax-filing-board";
import { GOODS_COST_CONSOLIDATED_LABEL } from "../goods-cost";
import { isSupplierInvoiceLabel, isSellerInvoiceLabel } from "../campaign-checklist";
import type { CampaignRow } from "@/lib/crm-types";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealName: "딜A",
    campaignName: "딜A - 셀러1 1차",
    partnerName: "공급사A",
    // 2026-08-04 부터 `counterpartBlockingReasons`가 SUPPLIER 상대도 검증한다(Gap #1
    // 정정) — 이 값들이 없으면 아래 대부분의 SUPPLIER 상대 행이 결번으로 막혀
    // `selectable: true`를 기대하는 기존 테스트가 깨진다. 결번 자체를 다투는 테스트는
    // 이 필드를 명시적으로 null 로 덮어써 검증한다.
    partnerBusinessNumber: "1231231231",
    partnerCeoName: "공급사대표",
    sellerId: "s1",
    sellerName: "셀러1",
    endDate: "2026-07-10",
    payoutCompletedAt: "2026-07-20",
    salesChannel: "SELLER_MALL",
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "1234567890",
    actualSales: 11_000_000,
    sellerExpense: 2_200_000,
    settlementSales: 5_500_000,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    ...overrides,
  } as CampaignRow;
}

function rowFor(rows: TaxInvoiceBoardRow[], direction: "ISSUE" | "RECEIVE") {
  return rows.find((r) => r.direction === direction);
}

describe("resolveTaxFilingChannelGroup — campaign-checklist.ts 와 동일한 분기", () => {
  it("OWN_MALL 계열(네이버·카카오 포함)은 OWN_MALL 로 묶인다", () => {
    expect(resolveTaxFilingChannelGroup("OWN_MALL")).toBe("OWN_MALL");
    expect(resolveTaxFilingChannelGroup("OWN_MALL_NAVER")).toBe("OWN_MALL");
    expect(resolveTaxFilingChannelGroup("OWN_MALL_KAKAO")).toBe("OWN_MALL");
  });

  it("BRAND_MALL 은 정확히 일치할 때만 브랜드몰이다", () => {
    expect(resolveTaxFilingChannelGroup("BRAND_MALL")).toBe("BRAND_MALL");
  });

  it("SELLER_MALL·UNSPECIFIED 는 모두 셀러몰로 떨어진다(기존 동작)", () => {
    expect(resolveTaxFilingChannelGroup("SELLER_MALL")).toBe("SELLER_MALL");
    expect(resolveTaxFilingChannelGroup("UNSPECIFIED")).toBe("SELLER_MALL");
  });
});

describe("buildTaxInvoiceWorkBoard — 공통 동작", () => {
  // ⛔ "지급월이 다른 캠페인은 제외한다" 단언은 2026-08-09 축 분리로 삭제했다 —
  // 세금계산서 작업 보드는 캠페인 상태 축(월 무관)이라 지급월로 거르지 않는 것이
  // 이 PR 의 목적이다(회귀가 아니라 의도한 동작 변경).
  it("개인 셀러는 셀러 상대 의무만 빠진다(원천징수 대상) — 셀러몰 기준, 공급사 수취는 남는다", () => {
    // ⚠️ 2026-08-07 정정 이후 셀러몰도 공급사 상대 의무(RECEIVE/SUPPLIER)가 있어
    // "캠페인 단위 스킵"이 아니라는 것을 이 테스트가 고정한다 — 개인 셀러라도
    // 공급사 쪽 의무는 세무 유형과 무관하게 남아야 한다. 채널별 구분은 아래
    // describe 블록이 고정한다.
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL" })],
      "2026-07",
    );
    expect(board.rows.map((r) => r.counterpart)).toEqual(["SUPPLIER"]);
  });

  it("이미 처리된 방향(날짜 필드가 채워짐)은 행을 만들지 않는다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL", supplierInvoiceIssuedAt: "2026-07-25" })],
      "2026-07",
    );
    expect(board.rows.map((r) => r.direction)).toEqual(["RECEIVE"]);
  });

  it("순수 함수는 DB 접근이 없어 warnings 를 비운 채로 돌려준다(호출부가 채운다)", () => {
    const board = buildTaxInvoiceWorkBoard([makeCampaign()], "2026-07");
    expect(board.warnings).toEqual([]);
  });
});

describe("개인 셀러 × 채널 — 스킵은 캠페인 단위가 아니라 '상대=SELLER' 의무 단위여야 한다", () => {
  // 2026-08-04 실사고: 캠페인 단위(`isIndividualSeller(campaign)`이면 캠페인 전체
  // continue)로 걸었더니, 개인 셀러 캠페인의 공급사 쪽 의무(브랜드몰 발행·우리몰
  // 수취)까지 통째로 사라졌다 — 체크리스트에는 그 항목이 그대로 생기는데 보드엔
  // 대응 행이 없어, 오너가 그 의무의 존재 자체를 모르게 되는 사고였다. 셀러의
  // 세무 유형은 "셀러가 상대인" 의무에만 영향을 준다.
  it("BRAND_MALL × INDIVIDUAL — 공급사 발행(ISSUE/SUPPLIER) 의무는 살아남고, 셀러 수취 의무만 없어진다(정확히 1행)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL", sellerTaxType: "INDIVIDUAL" })],
      "2026-07",
    );
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({ direction: "ISSUE", counterpart: "SUPPLIER" });
  });

  it("OWN_MALL × INDIVIDUAL — 공급사 수취(RECEIVE/SUPPLIER) 의무는 살아남고, 셀러 수취 의무만 없어진다(정확히 1행)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL" })],
      "2026-07",
    );
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({ direction: "RECEIVE", counterpart: "SUPPLIER" });
  });

  it("SELLER_MALL × INDIVIDUAL — 셀러 상대 행만 사라지고 공급사 수취는 남는다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL" })],
      "2026-07",
    );
    expect(board.rows.map((r) => r.counterpart)).toEqual(["SUPPLIER"]);
  });
});

describe("셀러몰(SELLER_MALL, UNSPECIFIED 포함) — 공급사 수취 + 셀러 발행 2건", () => {
  it("공급사 수취·셀러 발행 두 행이 생긴다(2026-08-07 오너 정정)", () => {
    const board = buildTaxInvoiceWorkBoard([makeCampaign({ salesChannel: "SELLER_MALL" })], "2026-07");
    expect(board.rows).toHaveLength(2);

    const supplier = board.rows.find((r) => r.sourceField === "supplierInvoiceIssuedAt")!;
    expect(supplier.direction).toBe("RECEIVE");
    expect(supplier.counterpart).toBe("SUPPLIER");
    expect(supplier.xlsxEligible).toBe(false);

    const seller = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    expect(seller.direction).toBe("ISSUE");
    expect(seller.counterpart).toBe("SELLER");
    expect(seller.xlsxEligible).toBe(true);
  });

  it("셀러 발행 금액은 actualSales - sellerExpense 이다(셀러수수료 제외 전체)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 })],
      "2026-07",
    );
    const seller = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    // (11,000,000 - 2,200,000) = 8,800,000 (VAT 포함) → 공급가 8,000,000 / 세액 800,000
    expect(seller.amount).toEqual({ supplyAmount: 8_000_000, taxAmount: 800_000 });
  });

  it("공급사 수취 금액은 actualSales - settlementSales(상품 공급가)이다 — 전 채널 공통식", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", actualSales: 11_000_000, settlementSales: 5_500_000 })],
      "2026-07",
    );
    const supplier = board.rows.find((r) => r.sourceField === "supplierInvoiceIssuedAt")!;
    expect(supplier.amount).toEqual({ supplyAmount: 5_000_000, taxAmount: 500_000 });
  });

  it("sellerInvoiceIssuedAt 이 이미 찍혔으면 셀러 발행 행만 사라진다(공급사 수취는 남는다)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", sellerInvoiceIssuedAt: "2026-07-01" })],
      "2026-07",
    );
    expect(board.rows.map((r) => r.sourceField)).toEqual(["supplierInvoiceIssuedAt"]);
  });

  it("UNSPECIFIED 도 셀러몰과 완전히 동일하게 동작한다", () => {
    const board = buildTaxInvoiceWorkBoard([makeCampaign({ salesChannel: "UNSPECIFIED" })], "2026-07");
    expect(board.rows).toHaveLength(2);
  });

  it("counterpartName 은 상대에 따라 갈린다 — 셀러 행은 사업자 상호, 공급사 행은 거래처명", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", sellerCompanyName: "○○커머스", partnerName: "△△브랜드" })],
      "2026-07",
    );
    expect(board.rows.find((r) => r.counterpart === "SELLER")!.counterpartName).toBe("○○커머스");
    expect(board.rows.find((r) => r.counterpart === "SUPPLIER")!.counterpartName).toBe("△△브랜드");
  });

  it("actualSales 가 없으면 셀러 발행 행이 선택 불가로 막힌다(0 을 내지 않는다)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", actualSales: null })],
      "2026-07",
    );
    const seller = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    expect(seller.selectable).toBe(false);
    expect(seller.blockingReasons.join()).toContain("실매출");
  });

  it("sellerExpense 가 없으면 막히고, 그때도 amount 는 actualSales 전액이 아니다", () => {
    // sellerExpense 를 ?? 0 으로 대체하면 "결번인데 금액 칸엔 매출 전액"이 된다.
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: null })],
      "2026-07",
    );
    const seller = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    expect(seller.selectable).toBe(false);
    expect(seller.blockingReasons.join()).toContain("정산금");
    expect(seller.amount).not.toEqual({ supplyAmount: 10_000_000, taxAmount: 1_000_000 });
  });
});

describe("브랜드몰(BRAND_MALL) — 발행 → 공급사(총 RS), 수취 ← 셀러(수수료)", () => {
  it("두 방향 행이 모두 생기고 상대·방향이 각각 다르다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL" })],
      "2026-07",
    );
    expect(board.rows).toHaveLength(2);

    const issueRow = rowFor(board.rows, "ISSUE")!;
    expect(issueRow.counterpart).toBe("SUPPLIER");
    expect(issueRow.counterpartName).toBe("공급사A");
    expect(issueRow.xlsxEligible).toBe(true);

    const receiveRow = rowFor(board.rows, "RECEIVE")!;
    expect(receiveRow.counterpart).toBe("SELLER");
    expect(receiveRow.xlsxEligible).toBe(false);
  });

  it("발행 → 공급사 금액은 settlementSales(영업수익) 기준이다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL", settlementSales: 5_500_000 })],
      "2026-07",
    );
    const issueRow = rowFor(board.rows, "ISSUE")!;
    // round(5,500,000/1.1)=5,000,000, round(5,000,000*0.1)=500,000
    expect(issueRow.amount).toEqual({ supplyAmount: 5_000_000, taxAmount: 500_000 });
  });

  it("수취 ← 셀러 금액은 sellerExpense(수수료) 기준이다 — 발행 금액과 다르다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL", settlementSales: 5_500_000, sellerExpense: 2_200_000 })],
      "2026-07",
    );
    const receiveRow = rowFor(board.rows, "RECEIVE")!;
    expect(receiveRow.amount).toEqual({ supplyAmount: 2_000_000, taxAmount: 200_000 });
  });
});

describe("우리몰(OWN_MALL 계열) — 발행 없음, 두 행 모두 수취", () => {
  it("두 행 모두 RECEIVE 다 — 우리몰엔 우리가 발행하는 계산서가 없다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL" })],
      "2026-07",
    );
    expect(board.rows).toHaveLength(2);
    expect(board.rows.every((r) => r.direction === "RECEIVE")).toBe(true);
    expect(board.rows.every((r) => r.xlsxEligible === false)).toBe(true);
  });

  it("공급사 수취 금액은 actualSales-settlementSales(상품 공급가) 기준으로 확정 계산된다", () => {
    // 매출 11,000,000 · settlementSales(영업수익) 3,300,000 → 공급사 물품대금
    // (VAT 포함) = 11,000,000 - 3,300,000 = 7,700,000. 다른 후보식과 값이 갈리도록
    // 고른 픽스처: sellerExpense(2,200,000) 그대로 쓰면 잘못 배선된 SELLER_COMMISSION
    // 과 겹치고, settlementSales(3,300,000) 그대로 쓰면 잘못 배선된 SETTLEMENT_SALES
    // 와 겹친다 — 세 값(11,000,000 / 3,300,000 / 2,200,000)이 서로 달라야
    // actualSales-settlementSales 오배선을 실제로 구분해낸다.
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({
          salesChannel: "OWN_MALL",
          actualSales: 11_000_000,
          settlementSales: 3_300_000,
          sellerExpense: 2_200_000,
        }),
      ],
      "2026-07",
    );
    const supplierRow = board.rows.find((r) => r.counterpart === "SUPPLIER")!;
    // round(7,700,000/1.1)=7,000,000, round(7,000,000*0.1)=700,000
    expect(supplierRow.amount).toEqual({ supplyAmount: 7_000_000, taxAmount: 700_000 });
    expect(supplierRow.selectable).toBe(true);
  });

  it("공급사 수취는 actualSales 가 없으면 선택 불가로 막는다(0 을 내지 않는다)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL", actualSales: null })],
      "2026-07",
    );
    const supplierRow = board.rows.find((r) => r.counterpart === "SUPPLIER")!;
    expect(supplierRow.selectable).toBe(false);
    expect(supplierRow.blockingReasons.join()).toContain("실매출");
  });

  it("공급사 수취는 settlementSales 가 없으면 actualSales 전액이 아니라 선택 불가로 막는다", () => {
    // 이 식은 뺄셈(actualSales-settlementSales)이라 settlementSales==null 을 0으로
    // 치면 위험 방향이 SETTLEMENT_SALES 기준과 정반대로 뒤집힌다 — SETTLEMENT_SALES
    // 는 null→0 이 "0 이하" 가드에 걸려 안전하게 결번 처리되지만, 이 식은 null→0 을
    // 빼면 actualSales 전액(물품대금의 몇 배)이 그대로 통과해 버젓한 숫자로 보인다
    // (조용한 오답 — 오너가 이 숫자로 공급사 세금계산서를 대사하게 된다).
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({
          salesChannel: "OWN_MALL",
          actualSales: 11_000_000,
          settlementSales: null,
        }),
      ],
      "2026-07",
    );
    const supplierRow = board.rows.find((r) => r.counterpart === "SUPPLIER")!;
    expect(supplierRow.selectable).toBe(false);
    expect(supplierRow.blockingReasons.join()).toContain("영업수익");
    // round(11,000,000/1.1)=10,000,000 — settlementSales 를 0으로 치면 이 값이 나온다.
    // 결번 행이라도 이 값과 일치하면 "실은 계산해서 채웠다"는 뜻이라 사고가 재현된 것.
    expect(supplierRow.amount).not.toEqual({ supplyAmount: 10_000_000, taxAmount: 1_000_000 });
  });

  it("셀러 수취는 sellerExpense 기준으로 정상 계산된다 — 공급사 수취와 독립적이다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL", sellerExpense: 1_100_000 })],
      "2026-07",
    );
    const sellerRow = board.rows.find((r) => r.counterpart === "SELLER")!;
    expect(sellerRow.amount).toEqual({ supplyAmount: 1_000_000, taxAmount: 100_000 });
    expect(sellerRow.selectable).toBe(true);
  });

  it("네이버·카카오 하위 채널도 우리몰과 동일하게 취급한다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL_NAVER" })],
      "2026-07",
    );
    expect(board.rows.every((r) => r.direction === "RECEIVE")).toBe(true);
  });
});

describe("결번(상대 정보 누락) 처리", () => {
  it("사업자등록번호가 없으면 선택 불가로 격리하고 사유를 남긴다(상대=셀러)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL", sellerCompanyBusinessNumber: null })],
      "2026-07",
    );
    const receiveRow = rowFor(board.rows, "RECEIVE")!;
    expect(receiveRow.selectable).toBe(false);
    expect(receiveRow.blockingReasons.join()).toContain("사업자등록번호");
  });

  it("정산금(sellerExpense)이 0 이하면 셀러 수취 행이 선택 불가다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "OWN_MALL", sellerExpense: 0 })],
      "2026-07",
    );
    const sellerRow = board.rows.find((r) => r.counterpart === "SELLER")!;
    expect(sellerRow.selectable).toBe(false);
  });

  // ⛔ 2026-08-04 이전엔 `counterpartBlockingReasons`가 SUPPLIER 상대일 때 항상 빈
  // 배열을 반환했다 — 공급사 사업자등록번호가 없어도 보드가 그 사실을 몰랐다(Gap #1).
  // 지금은 `validateTaxInvoiceCampaigns(campaign, "SUPPLIER")`로 파트너 필드를 본다.
  it("공급사 사업자등록번호가 없으면 발행(ISSUE→SUPPLIER) 행도 선택 불가로 막힌다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ salesChannel: "BRAND_MALL", partnerBusinessNumber: null })],
      "2026-07",
    );
    const issueRow = rowFor(board.rows, "ISSUE")!;
    expect(issueRow.counterpart).toBe("SUPPLIER");
    expect(issueRow.selectable).toBe(false);
    expect(issueRow.blockingReasons.join()).toContain("사업자등록번호");
  });
});

describe("합계 — 방향별로 분리, 이중 계상하지 않는다", () => {
  it("발행 합계와 수취 합계가 서로 다른 값으로 각각 집계된다(같은 캠페인이 두 번 더해지지 않는다)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({
          id: "c1",
          salesChannel: "BRAND_MALL",
          settlementSales: 5_500_000, // 발행 → 공급사
          sellerExpense: 2_200_000, // 수취 ← 셀러
        }),
      ],
      "2026-07",
    );
    expect(board.totalsByDirection.ISSUE).toEqual({ supplyAmount: 5_000_000, taxAmount: 500_000 });
    expect(board.totalsByDirection.RECEIVE).toEqual({ supplyAmount: 2_000_000, taxAmount: 200_000 });
    // 이전 모델의 사고 재현 방지: 두 방향이 하나의 합계로 뭉쳐지면 7,000,000 이 나온다.
    expect(board.totalsByDirection.ISSUE.supplyAmount).not.toBe(
      board.totalsByDirection.ISSUE.supplyAmount + board.totalsByDirection.RECEIVE.supplyAmount,
    );
  });

  it("선택 불가 행(결번·미달)은 합계에서 제외된다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({
          id: "c1",
          salesChannel: "OWN_MALL",
          sellerExpense: 1_100_000,
          // 공급사 수취(actualSales-settlementSales)도 확정 기준이라 실매출이 없으면
          // 마찬가지로 막힌다 — 이 케이스로 "공급사 수취도 결번 배제 대상"임을 함께 본다.
          actualSales: null,
        }),
        makeCampaign({
          id: "c2",
          salesChannel: "BRAND_MALL",
          // 발행(→공급사) 쪽은 영업수익 0 이하로 막고, 수취(←셀러) 쪽은 사업자번호
          // 결번으로 막아 — 두 방향 모두 합계에서 빠지는지를 함께 확인한다.
          settlementSales: 0,
          sellerCompanyBusinessNumber: null,
          sellerExpense: 9_999_999,
        }),
      ],
      "2026-07",
    );
    // c1 의 셀러 수취(1,000,000)만 RECEIVE 합계에 들어간다. c1 의 공급사 수취는
    // actualSales 없어 선택 불가라 집계 대상이 아니고, c2 는 두 방향 모두 결번/미달로
    // 막힌다.
    expect(board.totalsByDirection.RECEIVE.supplyAmount).toBe(1_000_000);
    expect(board.totalsByDirection.ISSUE.supplyAmount).toBe(0);
  });
});

describe("정산 그룹 — (groupId, 의무) 당 한 행으로 합친다(2026-08-04 재검토)", () => {
  // CampaignGroup 은 supplierInvoiceIssuedAt·sellerInvoiceIssuedAt 을 멤버 전체가
  // 공유한다(스키마 1개 필드) — 실제 세금계산서도 그룹당 1건인데, 캠페인 단위로
  // 행을 내면 3인 그룹이 같은 의무를 3행으로 부풀린다(발행/수취 합계 오염, 배지
  // 오신고, 완료 시 3행이 동시에 사라져 버그처럼 보임).
  it("3인 그룹의 셀러몰 발행 의무는 1행으로 합쳐지고, 금액은 멤버 3인의 합이다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({
          id: "m1",
          groupId: "g1",
          salesChannel: "SELLER_MALL",
          actualSales: 11_000_000,
          sellerExpense: 2_200_000, // base 8,800,000
        }),
        makeCampaign({
          id: "m2",
          groupId: "g1",
          salesChannel: "SELLER_MALL",
          actualSales: 5_500_000,
          sellerExpense: 1_100_000, // base 4,400,000
        }),
        makeCampaign({
          id: "m3",
          groupId: "g1",
          salesChannel: "SELLER_MALL",
          actualSales: 2_750_000,
          sellerExpense: 550_000, // base 2,200,000
        }),
      ],
      "2026-07",
    );

    // 캠페인마다 3행씩(9행)이 아니라 의무당 1행이다 — 이게 이 defect 의 핵심 계약이다.
    // 2026-08-07 정정 이후 셀러몰은 의무가 2개(공급사 수취·셀러 발행)라 2행이 된다.
    expect(board.rows).toHaveLength(2);
    const row = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    expect(row.groupId).toBe("g1");
    expect(row.campaignIds.slice().sort()).toEqual(["m1", "m2", "m3"]);
    // 대표(campaignId)는 id 오름차순 첫 번째로 고정된다.
    expect(row.campaignId).toBe("m1");
    // base 합계 8,800,000+4,400,000+2,200,000=15,400,000 → /1.1=14,000,000, ×0.1=1,400,000
    expect(row.amount).toEqual({ supplyAmount: 14_000_000, taxAmount: 1_400_000 });
    expect(row.selectable).toBe(true);

    // pendingCount·합계도 의무당 1행 기준으로 정확해야 한다 — 3중 카운트가 이 defect 의
    // 실제 피해(배지 오신고·발행 총액 부풀림)였다.
    expect(board.pendingCount).toBe(2);
    expect(board.totalsByDirection.ISSUE).toEqual({ supplyAmount: 14_000_000, taxAmount: 1_400_000 });
  });

  it("그룹 멤버 중 한 명이라도 결번이면 합산 금액이 양수여도 행 전체가 선택 불가다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({ id: "m1", groupId: "g2", salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 }),
        // m2 는 actualSales 가 없어 원금을 계산할 수 없다 — 그룹 총액이 그럴듯한
        // 양수로 보여도(m1 몫만 반영된 값) 실제로는 m2 몫이 빠진 반쪽 숫자다.
        makeCampaign({ id: "m2", groupId: "g2", salesChannel: "SELLER_MALL", actualSales: null, sellerExpense: 1_100_000 }),
      ],
      "2026-07",
    );

    expect(board.rows.length).toBeGreaterThan(0);
    const row = board.rows.find((r) => r.sourceField === "sellerInvoiceIssuedAt")!;
    expect(row.selectable).toBe(false);
    expect(row.blockingReasons.join()).toContain("실매출");
  });

  it("그룹 필드가 이미 처리된 의무는 대표 하나만 확인해 스킵한다(멤버 전원이 같은 값을 공유)", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({ id: "m1", groupId: "g3", salesChannel: "SELLER_MALL", supplierInvoiceIssuedAt: "2026-07-20" }),
        makeCampaign({ id: "m2", groupId: "g3", salesChannel: "SELLER_MALL", supplierInvoiceIssuedAt: "2026-07-20" }),
      ],
      "2026-07",
    );
    // supplierInvoiceIssuedAt 은 이미 처리됐으니 그 행만 스킵되고, sellerInvoiceIssuedAt
    // 은 여전히 미처리라 1행이 남는다(2026-08-07 정정 이후 셀러몰도 두 의무를 갖는다).
    expect(board.rows.map((r) => r.sourceField)).toEqual(["sellerInvoiceIssuedAt"]);
  });

  it("각 행은 sourceField 를 그대로 싣는다 — route 가 counterpart/direction 으로 재유도하지 않는다", () => {
    const board = buildTaxInvoiceWorkBoard(
      [
        makeCampaign({ id: "m1", groupId: "g4", salesChannel: "OWN_MALL" }),
        makeCampaign({ id: "m2", groupId: "g4", salesChannel: "OWN_MALL" }),
      ],
      "2026-07",
    );
    expect(board.rows).toHaveLength(2);
    const supplierRow = board.rows.find((r) => r.counterpart === "SUPPLIER")!;
    const sellerRow = board.rows.find((r) => r.counterpart === "SELLER")!;
    expect(supplierRow.sourceField).toBe("supplierInvoiceIssuedAt");
    expect(sellerRow.sourceField).toBe("sellerInvoiceIssuedAt");
  });

  it("그룹에 속하지 않은 캠페인은 이전과 동일하게 캠페인 단위로 1행을 낸다(회귀 없음)", () => {
    // supplierInvoiceIssuedAt 은 이미 처리됐다고 두어 sellerInvoiceIssuedAt 의무
    // 하나만 남도록 한다(2026-08-07 정정 이후 셀러몰은 의무가 2개라, 이 테스트가
    // 확인하려는 "그룹핑 로직이 그룹 없는 캠페인엔 안 걸린다"는 것과 무관한 두 번째
    // 의무 행까지 세면 계약이 흐려진다).
    const board = buildTaxInvoiceWorkBoard(
      [makeCampaign({ id: "solo", groupId: null, supplierInvoiceIssuedAt: "2026-07-01" })],
      "2026-07",
    );
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].groupId).toBeNull();
    expect(board.rows[0].campaignIds).toEqual(["solo"]);
    expect(board.rows[0].campaignId).toBe("solo");
  });

  describe("채널 불일치 — 그룹 멤버끼리 판매채널이 다르면 조용히 하나를 고르지 않는다", () => {
    it("멤버 채널이 갈리면 합치지 못하고 캠페인별 행으로 후퇴하며 경고를 남긴다", () => {
      const board = buildTaxInvoiceWorkBoard(
        [
          // SELLER_MALL: 수취(RECEIVE/SUPPLIER) + 발행(ISSUE/SELLER) 2건(2026-08-07 정정).
          makeCampaign({ id: "m1", groupId: "g5", salesChannel: "SELLER_MALL" }),
          // BRAND_MALL: 발행(ISSUE/SUPPLIER) + 수취(RECEIVE/SELLER) 2건.
          makeCampaign({ id: "m2", groupId: "g5", salesChannel: "BRAND_MALL" }),
        ],
        "2026-07",
      );

      // 합쳐지지 않고 캠페인별로 그대로 4행(멤버 2 × 의무 2)이 나와야 한다(과다
      // 카운트지만, 채널이 갈리는 그룹은 안전하게 옛 동작으로 후퇴한다는 계약).
      expect(board.rows).toHaveLength(4);
      expect(board.rows.every((r) => r.groupId === "g5")).toBe(true);
      expect(new Set(board.rows.map((r) => r.campaignId))).toEqual(new Set(["m1", "m2"]));

      // 경고가 남아야 한다 — 오너가 데이터 문제를 알아야 한다(조용히 넘기지 않는다).
      expect(board.warnings.some((w) => w.includes("g5") && w.includes("판매채널"))).toBe(true);
    });

    it("채널이 일치하면 경고가 없다(오탐 방지 회귀)", () => {
      const board = buildTaxInvoiceWorkBoard(
        [
          makeCampaign({ id: "m1", groupId: "g6", salesChannel: "SELLER_MALL" }),
          makeCampaign({ id: "m2", groupId: "g6", salesChannel: "SELLER_MALL" }),
        ],
        "2026-07",
      );
      // 셀러몰 의무 2개(공급사 수취·셀러 발행)가 그룹당 1행씩, 총 2행으로 합쳐진다.
      expect(board.rows).toHaveLength(2);
      expect(board.warnings).toEqual([]);
    });
  });

  describe("공급사 불일치 — 그룹 멤버끼리 채널은 같아도 공급사(deal.partner)가 다르면 합치지 않는다", () => {
    // Finding 1(회귀): CampaignGroup 의 유일한 앱 불변식은 "같은 셀러"뿐이다
    // (prisma/schema.prisma — sellerId 주석, campaignGroupService 의 HETERO_SELLER
    // 검증). dealId 는 멤버마다 다를 수 있어 partnerName 도 갈릴 수 있다. 채널
    // 불일치 가드가 있어도 공급사 불일치는 걸러지지 않아, 두 브랜드몰 캠페인이 서로
    // 다른 공급사(partner)를 상대하는데도 한 행으로 뭉쳐져 한쪽에는 과다청구, 다른
    // 쪽에는 청구 자체가 누락되는 사고로 이어진다.
    it("BRAND_MALL 그룹 멤버의 공급사가 다르면 한 행으로 합치지 않고 캠페인별 행 + 경고를 낸다", () => {
      const board = buildTaxInvoiceWorkBoard(
        [
          makeCampaign({
            id: "m1",
            groupId: "g7",
            salesChannel: "BRAND_MALL",
            partnerName: "공급사A",
            partnerBusinessNumber: "1111111111", // 이름도 다르고 번호도 다르다 — 실제 별개 거래처
            settlementSales: 5_500_000, // 발행 → 공급사 기준액
          }),
          makeCampaign({
            id: "m2",
            groupId: "g7",
            salesChannel: "BRAND_MALL",
            partnerName: "공급사B",
            partnerBusinessNumber: "2222222222",
            settlementSales: 3_300_000,
          }),
        ],
        "2026-07",
      );

      // 합쳐지지 않고 캠페인별로 각자의 ISSUE/SUPPLIER 행(+ RECEIVE/SELLER 행)이
      // 나와야 한다 — 총 4행(멤버 2 × 의무 2).
      expect(board.rows).toHaveLength(4);
      const issueRows = board.rows.filter((r) => r.counterpart === "SUPPLIER");
      expect(issueRows).toHaveLength(2);
      expect(issueRows.map((r) => r.counterpartName).sort()).toEqual(["공급사A", "공급사B"]);
      expect(issueRows.find((r) => r.counterpartName === "공급사A")!.amount).toEqual({
        supplyAmount: 5_000_000,
        taxAmount: 500_000,
      });
      expect(issueRows.find((r) => r.counterpartName === "공급사B")!.amount).toEqual({
        supplyAmount: 3_000_000,
        taxAmount: 300_000,
      });

      // 경고가 남아야 한다 — 그리고 raw groupId cuid 만 덜렁 있는 게 아니라 오너가
      // 알아볼 수 있는 campaignLabel(대표 멤버 이름)이 앞세워져야 한다(작은 수정
      // 사항 — groupId 단독은 오너가 조치할 수 없는 내부 식별자다). id 를 추적용으로
      // 괄호에 alongside 남기는 것까지는 허용한다.
      const warning = board.warnings.find((w) => w.includes("공급사"));
      expect(warning).toBeDefined();
      // 대표(anchor, id 오름차순 첫 번째)는 m1 — 기본 픽스처의 캠페인명이 라벨로 뜬다.
      expect(warning).toContain("딜A - 셀러1 1차");
    });

    it("공급사가 같으면 정상적으로 합쳐진다(오탐 방지 회귀)", () => {
      const board = buildTaxInvoiceWorkBoard(
        [
          makeCampaign({ id: "m1", groupId: "g8", salesChannel: "BRAND_MALL", partnerName: "공급사A", settlementSales: 5_500_000 }),
          makeCampaign({ id: "m2", groupId: "g8", salesChannel: "BRAND_MALL", partnerName: "공급사A", settlementSales: 3_300_000 }),
        ],
        "2026-07",
      );
      expect(board.rows).toHaveLength(2);
      const issueRow = board.rows.find((r) => r.counterpart === "SUPPLIER")!;
      expect(issueRow.amount).toEqual({ supplyAmount: 8_000_000, taxAmount: 800_000 });
    });

    // ⛔ whole-branch 리뷰 실측(2026-08-04) — 이름만으로 판정하던 예전 로직은 이
    // 케이스를 놓쳤다: 상호가 우연히 같은 두 별개 거래처(사업자등록번호가 다름)를
    // 한 행으로 합쳐, 8,000,000원 전액이 "1111111111" 앞으로만 신고되고
    // "2222222222" 몫은 누구에게도 청구되지 않는 사고가 났다. 이제는 전 멤버가
    // 사업자등록번호를 갖고 있으면 이름이 아니라 정규화된 번호로 판정한다.
    it("상호가 같아도 사업자등록번호가 다르면 별개 거래처로 판정해 합치지 않는다(오탐 방지)", () => {
      const board = buildTaxInvoiceWorkBoard(
        [
          makeCampaign({
            id: "m1",
            groupId: "g9",
            salesChannel: "BRAND_MALL",
            partnerName: "공급사동일이름",
            partnerBusinessNumber: "1111111111",
            settlementSales: 5_500_000,
          }),
          makeCampaign({
            id: "m2",
            groupId: "g9",
            salesChannel: "BRAND_MALL",
            partnerName: "공급사동일이름", // 이름은 같다
            partnerBusinessNumber: "2222222222", // 번호는 다르다 — 실제 별개 거래처
            settlementSales: 3_300_000,
          }),
        ],
        "2026-07",
      );

      // 합쳐지지 않고 캠페인별로 각자의 ISSUE/SUPPLIER 행이 나와야 한다 — 8,000,000원
      // 단일 행(오탐)이 아니라 5,000,000 / 3,000,000 두 행이어야 한다.
      const issueRows = board.rows.filter((r) => r.counterpart === "SUPPLIER");
      expect(issueRows).toHaveLength(2);
      const buyerBizNumbers = issueRows.map((r) => r.campaignIds[0]).sort();
      expect(buyerBizNumbers).toEqual(["m1", "m2"]);
      expect(issueRows.map((r) => r.amount.supplyAmount).sort((a, b) => a - b)).toEqual([
        3_000_000, 5_000_000,
      ]);
      expect(board.warnings.some((w) => w.includes("공급사"))).toBe(true);
    });
  });
});

describe("resolveSellerIssueInvoiceObligation — Finding 2: 그룹이면 보드와 같은 합산 금액을 낸다", () => {
  // 캠페인 사이드패널 「신고자료출력」 도우미가 쓰는 함수다. 보드(`emitGroupRows`)는
  // 정산 그룹이면 세금계산서를 그룹당 1건(멤버 전원 합산)으로 취급한다 — 이 함수가
  // 캠페인 1건만 계산하면 오너가 두 표면에서 서로 다른 금액을 보고 둘 다 홈택스에
  // 손으로 입력하는 사고로 이어진다(회귀 재현).
  it("groupMembers 없이 부르면(기존 호출부) 캠페인 단독 금액을 그대로 낸다 — 회귀 없음", () => {
    const campaign = makeCampaign({
      salesChannel: "SELLER_MALL",
      actualSales: 11_000_000,
      sellerExpense: 2_200_000,
    });
    const result = resolveSellerIssueInvoiceObligation(campaign);
    expect(result).not.toBeNull();
    expect(result!.isGroupAmount).toBe(false);
    expect(result!.memberCount).toBe(1);
    // (11,000,000-2,200,000)=8,800,000 → 공급가 8,000,000 / 세액 800,000
    expect(result!.amount).toEqual({ supplyAmount: 8_000_000, taxAmount: 800_000 });
  });

  it("3인 그룹 멤버 전원을 groupMembers 로 넘기면 보드와 정확히 같은 합산 금액을 낸다", () => {
    // 보드 쪽 계약 테스트("3인 그룹의 셀러몰 발행 의무는 1행으로...")와 동일한
    // 픽스처(base 8,800,000+4,400,000+2,200,000=15,400,000 → 공급가 14,000,000).
    const campaign = makeCampaign({
      id: "m1",
      groupId: "g1",
      salesChannel: "SELLER_MALL",
      actualSales: 11_000_000,
      sellerExpense: 2_200_000,
    });
    const groupMembers = [
      { salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 },
      { salesChannel: "SELLER_MALL", actualSales: 5_500_000, sellerExpense: 1_100_000 },
      { salesChannel: "SELLER_MALL", actualSales: 2_750_000, sellerExpense: 550_000 },
    ];
    const result = resolveSellerIssueInvoiceObligation(campaign, groupMembers);
    expect(result).not.toBeNull();
    expect(result!.isGroupAmount).toBe(true);
    expect(result!.memberCount).toBe(3);
    expect(result!.amount).toEqual({ supplyAmount: 14_000_000, taxAmount: 1_400_000 });
  });

  it("그룹 멤버끼리 채널이 갈리면 보드처럼 캠페인 단독 금액으로 후퇴한다(조용히 하나를 고르지 않는다)", () => {
    const campaign = makeCampaign({
      salesChannel: "SELLER_MALL",
      actualSales: 11_000_000,
      sellerExpense: 2_200_000,
    });
    const groupMembers = [
      { salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 },
      { salesChannel: "BRAND_MALL", actualSales: 5_500_000, sellerExpense: 1_100_000 },
    ];
    const result = resolveSellerIssueInvoiceObligation(campaign, groupMembers);
    expect(result).not.toBeNull();
    expect(result!.isGroupAmount).toBe(false);
    expect(result!.memberCount).toBe(1);
    expect(result!.amount).toEqual({ supplyAmount: 8_000_000, taxAmount: 800_000 });
  });

  it("멤버 중 한 명이라도 결번이면 합산 금액이 양수여도 blockingReasons 가 채워진다", () => {
    const campaign = makeCampaign({ salesChannel: "SELLER_MALL" });
    const groupMembers = [
      { salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 },
      { salesChannel: "SELLER_MALL", actualSales: null, sellerExpense: 1_100_000 },
    ];
    const result = resolveSellerIssueInvoiceObligation(campaign, groupMembers);
    expect(result!.blockingReasons.join()).toContain("실매출");
  });
});

describe("세금계산서 체크리스트 라벨 판정", () => {
  it("공급사 라벨 2종을 모두 인식한다", () => {
    expect(isSupplierInvoiceLabel("공급사 매입 세금계산서 발행")).toBe(true);
    expect(isSupplierInvoiceLabel("공급사 총 수수료 매출 세금계산서 발행")).toBe(true);
  });

  it("셀러 라벨을 인식한다 — 옛 셀러몰 라벨(방향 단어 없음)도 하위호환으로 포함", () => {
    expect(isSellerInvoiceLabel("셀러 수수료 확정 및 계산서 수취")).toBe(true);
    expect(isSellerInvoiceLabel("셀러 수수료 매입 세금계산서 수취")).toBe(true);
    // 「확정 매출 기준 수수료 청구 세금계산서 발행」— 2026-08-07 방향 정정 전 셀러몰
    // 라벨. "셀러"라는 단어가 없지만 프로덕션에 이미 생성된 행이 있어 셀러 필드로
    // 계속 잡혀야 한다.
    expect(isSellerInvoiceLabel("확정 매출 기준 수수료 청구 세금계산서 발행")).toBe(true);
    expect(isSupplierInvoiceLabel("확정 매출 기준 수수료 청구 세금계산서 발행")).toBe(false);
  });

  it("두 판정이 겹치지 않는다", () => {
    const labels = [
      "공급사 매입 세금계산서 발행",
      "셀러 수수료 매입 세금계산서 수취",
      "대금 지급 및 입금 완료",
    ];
    for (const label of labels) {
      expect(isSupplierInvoiceLabel(label) && isSellerInvoiceLabel(label)).toBe(false);
    }
  });
});

describe("resolveSellerIssueInvoiceObligation — 슬롯 위치에 의존하지 않는다", () => {
  it("셀러몰은 셀러 발행 의무를 찾아낸다(슬롯이 seller 로 옮겨간 뒤에도)", () => {
    const obligation = resolveSellerIssueInvoiceObligation(
      makeCampaign({ salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 2_200_000 }),
    );
    expect(obligation).not.toBeNull();
    expect(obligation!.amount).toEqual({ supplyAmount: 8_000_000, taxAmount: 800_000 });
  });

  it("우리몰·브랜드몰은 셀러에게 발행하지 않으므로 null 이다", () => {
    expect(resolveSellerIssueInvoiceObligation(makeCampaign({ salesChannel: "OWN_MALL" }))).toBeNull();
    expect(resolveSellerIssueInvoiceObligation(makeCampaign({ salesChannel: "BRAND_MALL" }))).toBeNull();
  });
});

describe("resolveCampaignInvoiceSlots — 카드가 판정표에서 칸을 파생한다", () => {
  it("우리몰은 두 칸 다 수취다", () => {
    const slots = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "OWN_MALL" }));
    expect(slots.map((s) => [s.counterpart, s.direction])).toEqual([
      ["SUPPLIER", "RECEIVE"],
      ["SELLER", "RECEIVE"],
    ]);
    expect(slots[0].title).toBe("공급사 계산서 수취");
    expect(slots[1].title).toBe("셀러 계산서 수취");
  });

  it("브랜드몰은 공급사 발행 · 셀러 수취다", () => {
    const slots = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "BRAND_MALL" }));
    expect(slots.map((s) => s.direction)).toEqual(["ISSUE", "RECEIVE"]);
    expect(slots[0].title).toBe("공급사 계산서 발행");
  });

  it("셀러몰은 공급사 수취 · 셀러 발행이다(오너 확정 2026-08-07)", () => {
    const slots = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "SELLER_MALL" }));
    expect(slots.map((s) => s.direction)).toEqual(["RECEIVE", "ISSUE"]);
    expect(slots[1].title).toBe("셀러 계산서 발행");
  });

  it("UNSPECIFIED 는 셀러몰과 같다", () => {
    const slots = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "UNSPECIFIED" }));
    expect(slots.map((s) => s.direction)).toEqual(["RECEIVE", "ISSUE"]);
  });

  it("개인 셀러는 셀러 상대 칸만 해당 없음이다 — 공급사 칸은 그대로 남는다", () => {
    const slots = resolveCampaignInvoiceSlots(
      makeCampaign({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL" }),
    );
    expect(slots[0].applicable).toBe(true);
    expect(slots[1].applicable).toBe(false);
    expect(slots[1].inapplicableReason).toBe("개인 셀러(원천징수 대상)");
  });

  it("비적용 사유는 문구와 별개로 **코드**로도 나온다 — 화면이 한국어 문자열로 분기하지 않게", () => {
    // 정산 카드가 이 코드를 보고 개인 셀러 칸을 원천징수 신고 표시로 갈아끼운다.
    // `inapplicableReason` 문구를 비교해 분기하면 문구를 다듬는 순간 조용히 깨진다.
    const individual = resolveCampaignInvoiceSlots(
      makeCampaign({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL" }),
    );
    expect(individual[0].inapplicableCause).toBeNull();
    expect(individual[1].inapplicableCause).toBe("INDIVIDUAL_SELLER");

    const business = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "OWN_MALL" }));
    expect(business.map((slot) => slot.inapplicableCause)).toEqual([null, null]);
  });

  it("셀러몰의 개인 셀러도 같은 규칙 — 셀러 발행 칸이 해당 없음이 된다", () => {
    const slots = resolveCampaignInvoiceSlots(
      makeCampaign({ salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL" }),
    );
    expect(slots[1].applicable).toBe(false);
  });

  it("배지용 짧은 라벨을 채널 판정표에서 파생한다", () => {
    expect(
      resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "OWN_MALL" })).map((s) => s.shortTitle),
    ).toEqual(["공급사 수취", "셀러 수취"]);

    expect(
      resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "BRAND_MALL" })).map((s) => s.shortTitle),
    ).toEqual(["공급사 발행", "셀러 수취"]);

    expect(
      resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: "SELLER_MALL" })).map((s) => s.shortTitle),
    ).toEqual(["공급사 수취", "셀러 발행"]);
  });

  it("의무가 없는 셀러 슬롯도 shortTitle 을 갖는다", () => {
    // 배지가 라벨 대신 「해당 없음」을 쓰더라도 shortTitle 이 undefined 면 호출부가
    // 옵셔널 분기를 새로 만들게 된다.
    const slots = resolveCampaignInvoiceSlots(
      makeCampaign({ salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL" }),
    );
    expect(slots[1].applicable).toBe(false);
    expect(slots[1].shortTitle).toBe("셀러 발행");
  });

  it("칸 순서는 항상 [공급사 필드, 셀러 필드] 다 — 채널이 바뀌어도 자리가 흔들리지 않는다", () => {
    for (const channel of [
      "OWN_MALL",
      "OWN_MALL_NAVER",
      "BRAND_MALL",
      "SELLER_MALL",
      "UNSPECIFIED",
    ] as const) {
      const slots = resolveCampaignInvoiceSlots(makeCampaign({ salesChannel: channel }));
      expect(slots.map((s) => s.field)).toEqual(["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"]);
    }
  });
});

describe("resolveCampaignMoneySlots — 판정표에서 파생한다", () => {
  it("브랜드몰: 입금(공급사) + 지급(셀러) — 기존 필드 매핑", () => {
    const slots = resolveCampaignMoneySlots("BRAND_MALL");
    expect(slots.map((s) => [s.kind, s.counterpart])).toEqual([
      ["DEPOSIT", "SUPPLIER"],
      ["PAYOUT", "SELLER"],
    ]);
    expect(slots[0].expectedField).toBe("expectedDepositDate");
    expect(slots[1].expectedField).toBe("expectedPayoutDate");
  });

  it("셀러몰: 입금(셀러) + 지급(공급사) — 단일 지급 레그는 상대가 공급사여도 기존 payout 필드", () => {
    const slots = resolveCampaignMoneySlots("SELLER_MALL");
    expect(slots.map((s) => [s.kind, s.counterpart])).toEqual([
      ["DEPOSIT", "SELLER"],
      ["PAYOUT", "SUPPLIER"],
    ]);
    // 셀러몰 공급사 지급의 실데이터가 기존 필드에 쌓여 있다 — 전용 필드로 옮기면 안 보인다.
    expect(slots[1].expectedField).toBe("expectedPayoutDate");
    expect(slots[1].flagField).toBe("isPayoutCompleted");
  });

  it("자사몰: 입금 칸이 없고 지급(공급사)+지급(셀러) 두 칸이다", () => {
    const slots = resolveCampaignMoneySlots("OWN_MALL_NAVER");
    expect(slots.map((s) => [s.kind, s.counterpart])).toEqual([
      ["PAYOUT", "SUPPLIER"],
      ["PAYOUT", "SELLER"],
    ]);
    // 공급사 레그만 전용 필드, 셀러 레그는 기존 payout 필드를 잇는다(정산 본류 보존).
    expect(slots[0].expectedField).toBe("expectedSupplierPayoutDate");
    expect(slots[0].completedAtField).toBe("supplierPayoutCompletedAt");
    expect(slots[0].flagField).toBe("isSupplierPayoutCompleted");
    expect(slots[1].expectedField).toBe("expectedPayoutDate");
    expect(slots[1].flagField).toBe("isPayoutCompleted");
    expect(slots[0].counterpartLabel).toBe("공급사");
    expect(slots[1].counterpartLabel).toBe("셀러");
  });

  it("미지정 채널은 셀러몰 규칙을 따른다(resolveTaxFilingChannelGroup 폴백)", () => {
    expect(resolveCampaignMoneySlots("UNSPECIFIED")).toEqual(resolveCampaignMoneySlots("SELLER_MALL"));
  });

  // ⚠️ 「개인 셀러여도 지급 칸이 남는다」는 이 함수의 arity 로 단언하지 않는다(기본 인자
  //    하나에 깨지고 의도도 표현하지 못한다). 그 불변식은 Task C2 의 렌더 테스트가
  //    행위로 고정하고, 이 함수 쪽은 소스 주석이 이유를 남긴다.
});

describe("resolveSettlementCompletionFlags — 완료 판정 집합", () => {
  it("자사몰 = [공급사 지급, 셀러 지급], 그 외 = [입금, 지급]", () => {
    expect(resolveSettlementCompletionFlags("OWN_MALL_NAVER")).toEqual([
      "isSupplierPayoutCompleted",
      "isPayoutCompleted",
    ]);
    expect(resolveSettlementCompletionFlags("BRAND_MALL")).toEqual([
      "isDepositReceived",
      "isPayoutCompleted",
    ]);
    expect(resolveSettlementCompletionFlags("SELLER_MALL")).toEqual([
      "isDepositReceived",
      "isPayoutCompleted",
    ]);
  });
});

describe("구역 분류 — 진행 중 / 밀린 정리", () => {
  it("정산 완료(COMPLETED) 캠페인의 미처리 의무는 BACKLOG 다", () => {
    const { rows } = buildTaxInvoiceObligationRows([
      makeCampaign({ id: "c1", status: "COMPLETED" }),
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.section === "BACKLOG")).toBe(true);
  });

  it("정산 진행(SETTLEMENT_IN_PROGRESS) 캠페인은 IN_PROGRESS 다", () => {
    const { rows } = buildTaxInvoiceObligationRows([
      makeCampaign({ id: "c1", status: "SETTLEMENT_IN_PROGRESS" }),
    ]);
    expect(rows.every((r) => r.section === "IN_PROGRESS")).toBe(true);
  });

  it("그룹 멤버 상태가 섞이면 IN_PROGRESS 가 이긴다 — 진행 중 작업을 접힌 구역에 숨기지 않는다", () => {
    const { rows } = buildTaxInvoiceObligationRows([
      makeCampaign({ id: "c1", groupId: "g1", status: "COMPLETED" }),
      makeCampaign({ id: "c2", groupId: "g1", status: "SETTLEMENT_IN_PROGRESS" }),
    ]);
    const groupRows = rows.filter((r) => r.groupId === "g1");
    expect(groupRows.length).toBeGreaterThan(0);
    expect(groupRows.every((r) => r.section === "IN_PROGRESS")).toBe(true);
  });

  it("상태를 모르면(undefined) 숨기지 않는다 — IN_PROGRESS 로 떨어진다", () => {
    expect(resolveBoardSection([undefined])).toBe("IN_PROGRESS");
    expect(resolveBoardSection([])).toBe("IN_PROGRESS");
  });
});

describe("buildTaxInvoiceWorkBoard — 월 필터 없는 작업 보드", () => {
  it("pendingCount 는 진행 중만 세고 backlogCount 가 밀린 건을 따로 센다", () => {
    const board = buildTaxInvoiceWorkBoard([
      makeCampaign({ id: "c1", status: "SETTLEMENT_IN_PROGRESS" }),
      makeCampaign({ id: "c2", status: "COMPLETED" }),
    ]);
    const inProgress = board.rows.filter((r) => r.section === "IN_PROGRESS");
    const backlog = board.rows.filter((r) => r.section === "BACKLOG");

    expect(inProgress.length).toBeGreaterThan(0);
    expect(backlog.length).toBeGreaterThan(0);
    expect(board.pendingCount).toBe(inProgress.length);
    expect(board.backlogCount).toBe(backlog.length);
  });

  it("totalsByDirection 에 BACKLOG 금액을 섞지 않는다 — 오너가 홈택스에 옮기는 숫자다", () => {
    const onlyBacklog = buildTaxInvoiceWorkBoard([
      makeCampaign({ id: "c1", status: "COMPLETED" }),
    ]);
    expect(onlyBacklog.rows.length).toBeGreaterThan(0);
    expect(onlyBacklog.totalsByDirection.ISSUE.supplyAmount).toBe(0);
    expect(onlyBacklog.totalsByDirection.RECEIVE.supplyAmount).toBe(0);
  });

  it("blockedCount 는 두 구역을 합산한다 — 결번은 어느 구역이든 오너가 알아야 한다", () => {
    const board = buildTaxInvoiceWorkBoard([
      makeCampaign({ id: "c1", status: "COMPLETED", partnerBusinessNumber: null }),
    ]);
    expect(board.blockedCount).toBe(board.rows.filter((r) => !r.selectable).length);
    expect(board.blockedCount).toBeGreaterThan(0);
  });

  it("지급완료일이 없어도 행이 나온다 — 이번 버그의 직접 회귀", () => {
    const board = buildTaxInvoiceWorkBoard([
      makeCampaign({ id: "c1", status: "SETTLEMENT_IN_PROGRESS", payoutCompletedAt: null }),
    ]);
    expect(board.rows.length).toBeGreaterThan(0);
  });
});

describe("resolveMoneySlotDisplayAmount — 대금 칸 금액은 의무표 기준에서 파생한다", () => {
  /**
   * T-055(오너 확정 2026-08-25): 대금 칸이 읽던 `settlementDeposit`·`settlementPayout` 은
   * 프로덕션에서 한 번도 쓰인 적 없는 컬럼이라 전 표면이 「미정」이었다. 금액은 컬럼을
   * 새로 고르는 게 아니라 **세금계산서 의무표의 `amountBasis`** 에서 파생한다 — 계산서는
   * 항상 지급보다 먼저이고 같은 거래의 같은 금액이기 때문이다.
   */
  const campaign = { actualSales: 1_000_000, settlementSales: 300_000, sellerExpense: 120_000 };

  function slotOf(channel: string, key: CampaignMoneySlot["key"]): CampaignMoneySlot {
    return resolveCampaignMoneySlots(channel).find((slot) => slot.key === key)!;
  }

  it("브랜드몰 입금(공급사) = 영업수익", () => {
    expect(resolveMoneySlotDisplayAmount(slotOf("BRAND_MALL", "deposit"), campaign)).toBe(300_000);
  });

  it("셀러몰 입금(셀러) = 실매출 − 판매대행비", () => {
    expect(resolveMoneySlotDisplayAmount(slotOf("SELLER_MALL", "deposit"), campaign)).toBe(880_000);
  });

  // ⚠️ 셀러몰에는 **셀러 지급 칸이 없다** — 그 채널의 셀러는 우리가 청구해 **받는**
  // 상대다(의무표: 셀러몰 sellerInvoiceIssuedAt = ISSUE → 입금). 셀러 지급이 존재하는
  // 채널은 브랜드몰·자사몰 둘뿐이고, 거기서는 상대가 같으므로 금액 기준도 같다.
  it("셀러 지급이 있는 채널에서는 금액이 판매대행비다", () => {
    for (const channel of ["BRAND_MALL", "OWN_MALL"]) {
      const slot = resolveCampaignMoneySlots(channel).find(
        (s) => s.kind === "PAYOUT" && s.counterpart === "SELLER",
      )!;
      expect(slot).toBeTruthy();
      expect(resolveMoneySlotDisplayAmount(slot, campaign)).toBe(120_000);
    }
  });

  it("셀러몰의 셀러는 지급이 아니라 입금 상대다 — 칸을 만들지 않는다", () => {
    const sellerPayout = resolveCampaignMoneySlots("SELLER_MALL").find(
      (s) => s.kind === "PAYOUT" && s.counterpart === "SELLER",
    );
    expect(sellerPayout).toBeUndefined();
  });

  // ── 공급사 물품대금 3-상태 (T-057, 오너 승인 2026-08-27) ──────────────────
  // 종전 계약은 "항상 null" 이었다. 그 판정의 근거(계산서 한 장이 여러 캠페인을 묶는다)는
  // **수기값의 3-상태가 이미 닫는다** — 총액은 주 캠페인에, 합산된 쪽엔 `0`.
  // ⛔ 아래 세 단언을 하나로 접지 말 것: 셋은 서로 다른 사실이고 게이트 문구도 갈린다.

  it("공급사 물품대금 = 수기 입력값(관측)이 정본이다", () => {
    const entered = { ...campaign, settlementGoodsCost: 620_000 };
    expect(resolveMoneySlotDisplayAmount(slotOf("SELLER_MALL", "payout"), entered)).toBe(620_000);
    expect(resolveMoneySlotDisplayAmount(slotOf("OWN_MALL", "supplierPayout"), entered)).toBe(620_000);
  });

  it("미입력이면 「미정」이다 — ⛔ 공식(actualSales − settlementSales)으로 메우지 않는다", () => {
    // `campaign` 은 actualSales·settlementSales 를 **둘 다** 갖고 있다. 공식이 살아 있다면
    // 여기서 700,000 이 나온다 — 그 값이 나오면 2026-08-06 에 실물 대조로 기각된 추정이
    // 되살아난 것이다(오너가 그 숫자로 공급사에 송금하게 된다).
    expect(campaign.actualSales - campaign.settlementSales).toBe(700_000); // 양성 프로브
    expect(resolveMoneySlotDisplayAmount(slotOf("SELLER_MALL", "payout"), campaign)).toBeNull();
    expect(resolveMoneySlotDisplayAmount(slotOf("OWN_MALL", "supplierPayout"), campaign)).toBeNull();
  });

  it("`0` 은 「합산 이관」이라 0 원이다 — null(모름)로 접지 않는다", () => {
    const consolidated = { ...campaign, settlementGoodsCost: 0 };
    expect(resolveMoneySlotDisplayAmount(slotOf("SELLER_MALL", "payout"), consolidated)).toBe(0);
  });

  it("합산 이관은 화면에 **금액이 아니라 문구**로 나간다 (재무 카드와 같은 문자열)", () => {
    // ⛔ `₩0` 으로 적으면 「확인된 0원」으로 읽혀 오너가 입력 실수를 의심한다.
    //    산술(합계·그룹 접기)에서는 여전히 0 이 맞는 기여값이라 채널을 나눠 둔 것이다.
    const slot = slotOf("SELLER_MALL", "payout");
    const consolidated = { ...campaign, settlementGoodsCost: 0 };
    expect(resolveMoneySlotDisplayAmount(slot, consolidated)).toBe(0); // 산술 채널
    expect(resolveMoneySlotAmountDisplay(slot, consolidated)).toEqual({
      kind: "STATE",
      text: GOODS_COST_CONSOLIDATED_LABEL,
    });
  });

  it("표시 판정의 나머지 두 갈래 — 금액 / 미정", () => {
    const slot = slotOf("SELLER_MALL", "payout");
    expect(
      resolveMoneySlotAmountDisplay(slot, { ...campaign, settlementGoodsCost: 620_000 }),
    ).toEqual({ kind: "AMOUNT", amount: 620_000 });
    expect(resolveMoneySlotAmountDisplay(slot, campaign)).toEqual({ kind: "UNKNOWN" });
  });

  it("다른 기준에는 상태 갈래가 없다 — 합산 이관은 물품대금만의 개념이다", () => {
    for (const [channel, key] of [
      ["BRAND_MALL", "deposit"],
      ["BRAND_MALL", "payout"],
      ["SELLER_MALL", "deposit"],
    ] as const) {
      // 물품대금 컬럼에 0 이 있어도 다른 기준의 표시가 상태로 바뀌면 안 된다.
      const display = resolveMoneySlotAmountDisplay(slotOf(channel, key), {
        ...campaign,
        settlementGoodsCost: 0,
      });
      expect(display.kind).not.toBe("STATE");
    }
  });

  it("게이트 문구는 미입력과 합산 이관을 다르게 말한다", () => {
    const slot = slotOf("SELLER_MALL", "payout");
    // 미입력 → 채우면 열린다.
    const unfilled = describeMoneySlotAmountBlock(slot, campaign);
    expect(unfilled.kind).toBe("FILLABLE");
    expect(unfilled).toMatchObject({ needs: expect.stringContaining("settlementGoodsCost") });
    // 합산 이관 → 채울 대상이 없다. ⛔ 「입력 후 다시 시도」로 안내하면 오너가 이미
    //    올바르게 넣은 0 을 지우고 남의 금액을 옮겨 적게 된다.
    const consolidated = describeMoneySlotAmountBlock(slot, {
      ...campaign,
      settlementGoodsCost: 0,
    });
    expect(consolidated.kind).toBe("NOT_APPLICABLE");
  });

  it("다른 기준은 캠페인 값과 무관하게 채울 컬럼을 말한다", () => {
    for (const [channel, key] of [
      ["BRAND_MALL", "deposit"],
      ["BRAND_MALL", "payout"],
      ["SELLER_MALL", "deposit"],
    ] as const) {
      expect(describeMoneySlotAmountBlock(slotOf(channel, key), {}).kind).toBe("FILLABLE");
    }
  });

  it("그룹 접기 규약 — 물품대금만 「하나라도 모르면 전체가 모름」이다", () => {
    expect(resolveMoneySlotGroupFold(slotOf("SELLER_MALL", "payout"))).toBe("ALL_OR_NOTHING");
    expect(resolveMoneySlotGroupFold(slotOf("OWN_MALL", "supplierPayout"))).toBe("ALL_OR_NOTHING");
    // 나머지는 아는 멤버만 더한다 — 멤버별로 독립인 금액이라 부분 합계가 그 자체로 사실이다.
    expect(resolveMoneySlotGroupFold(slotOf("BRAND_MALL", "deposit"))).toBe("SKIP_UNKNOWN");
    expect(resolveMoneySlotGroupFold(slotOf("BRAND_MALL", "payout"))).toBe("SKIP_UNKNOWN");
    expect(resolveMoneySlotGroupFold(slotOf("SELLER_MALL", "deposit"))).toBe("SKIP_UNKNOWN");
  });

  it("근거 값이 없으면 0 이 아니라 null 이다", () => {
    expect(resolveMoneySlotDisplayAmount(slotOf("BRAND_MALL", "deposit"), {})).toBeNull();
    expect(resolveMoneySlotDisplayAmount(slotOf("BRAND_MALL", "payout"), {})).toBeNull();
  });

  it("뺄셈 기준은 한쪽만 없어도 null 이다 — 매출 전액이 새어나가지 않는다", () => {
    const amount = resolveMoneySlotDisplayAmount(slotOf("SELLER_MALL", "deposit"), {
      actualSales: 1_000_000,
    });
    expect(amount).toBeNull();
  });

  it("모든 슬롯이 금액 기준을 들고 있다 — 소비처가 채널로 다시 유도하지 않는다", () => {
    for (const channel of ["BRAND_MALL", "SELLER_MALL", "OWN_MALL"]) {
      for (const slot of resolveCampaignMoneySlots(channel)) {
        expect(slot.amountBasis).toBeTruthy();
      }
    }
  });
});

describe("resolveMoneySlotDisplayAmount — 셀러 지급은 실지급액이 우선한다", () => {
  /**
   * 오너 확정 2026-08-26(T-055 후속): 대금 칸은 **이체 일정**이라 지급이 끝난 뒤에는
   * 예정액이 아니라 **실제 나간 금액**을 보여준다. 모바일 캠페인 카드가 이미 같은 규칙
   * (`actualPayoutAmount ?? sellerExpense`)을 써 왔으므로 표면 간 표기가 통일된다.
   */
  const sellerPayout = resolveCampaignMoneySlots("BRAND_MALL").find(
    (slot) => slot.kind === "PAYOUT" && slot.counterpart === "SELLER",
  )!;

  it("실지급액이 있으면 그 값을 쓴다", () => {
    const amount = resolveMoneySlotDisplayAmount(sellerPayout, {
      sellerExpense: 120_000,
      actualPayoutAmount: 118_400,
    });
    expect(amount).toBe(118_400);
  });

  it("실지급액이 없으면 예정액(판매대행비)으로 떨어진다", () => {
    expect(resolveMoneySlotDisplayAmount(sellerPayout, { sellerExpense: 120_000 })).toBe(120_000);
  });

  it("둘 다 없으면 0 이 아니라 null 이다", () => {
    expect(resolveMoneySlotDisplayAmount(sellerPayout, {})).toBeNull();
  });

  it("입금 칸은 실지급액에 영향받지 않는다 — 축이 다르다", () => {
    const deposit = resolveCampaignMoneySlots("BRAND_MALL").find((s) => s.key === "deposit")!;
    const amount = resolveMoneySlotDisplayAmount(deposit, {
      settlementSales: 300_000,
      actualPayoutAmount: 999_999,
    });
    expect(amount).toBe(300_000);
  });

  /**
   * ⛔ **세금계산서 금액은 실지급액을 따라가지 않는다.** 계산서는 약정 금액(판매대행비)
   * 으로 발행되고, 실지급액은 원천징수·조정을 거친 **이체 결과**다. 두 축이 갈리는
   * 유일한 지점이라 계약으로 고정한다 — 여기를 합치면 홈택스에 옮기는 숫자가 틀어진다.
   */
  it("세무 보드의 계산서 원금은 여전히 판매대행비다", () => {
    const { baseAmount } = computeBaseAmountForBasis("SELLER_COMMISSION", {
      actualSales: 1_000_000,
      sellerExpense: 120_000,
      settlementSales: 300_000,
      actualPayoutAmount: 118_400,
    } as never);
    expect(baseAmount).toBe(120_000);
  });
});

describe("resolveMoneySlotEffectiveDate — 완료되면 예정일이 아니라 실제일에 선다", () => {
  /**
   * 오너 지적 2026-07-15: "20일이 지급예정인데 15일에 지급되었으면 예정일정은
   * 캘린더에서 없어지고 지급일정으로 변경돼야 하는 거 아니야?"
   *
   * 구글 캘린더 동기화(`syncMoneyEvents`)는 이미 `완료일 ?? 예정일` 로 그리고 있었고
   * 앱 안 표면만 예정일에 고정돼 있었다 — 이 함수가 그 규칙의 유일한 소유자다.
   */
  function slotOf(channel: string, key: CampaignMoneySlot["key"]): CampaignMoneySlot {
    return resolveCampaignMoneySlots(channel).find((slot) => slot.key === key)!;
  }

  const sellerPayout = slotOf("BRAND_MALL", "payout");

  it("미완료면 예정일에 선다", () => {
    const result = resolveMoneySlotEffectiveDate(sellerPayout, {
      expectedPayoutDate: "2026-08-20",
      isPayoutCompleted: false,
    });
    expect(result).toEqual({ date: "2026-08-20", isActual: false });
  });

  it("완료되면 실제 지급일로 옮겨간다", () => {
    const result = resolveMoneySlotEffectiveDate(sellerPayout, {
      expectedPayoutDate: "2026-08-20",
      payoutCompletedAt: "2026-08-15",
      isPayoutCompleted: true,
    });
    expect(result).toEqual({ date: "2026-08-15", isActual: true });
  });

  /**
   * ⛔ 완료인데 완료일이 비어 있다고 **캘린더에서 사라지게 하지 말 것.** 완료일 컬럼이
   * 없던 시절의 행·그룹 스칼라가 비어 있는 행이 실재하고, 그것들이 화면에서 통째로
   * 없어지면 크래시 없는 침묵형 소실이 된다.
   */
  it("완료인데 완료일이 없으면 예정일에 남는다", () => {
    const result = resolveMoneySlotEffectiveDate(sellerPayout, {
      expectedPayoutDate: "2026-08-20",
      payoutCompletedAt: null,
      isPayoutCompleted: true,
    });
    expect(result).toEqual({ date: "2026-08-20", isActual: false });
  });

  it("둘 다 없으면 null 이다 — 그릴 날짜가 없다", () => {
    expect(resolveMoneySlotEffectiveDate(sellerPayout, {})).toEqual({
      date: null,
      isActual: false,
    });
  });

  /**
   * 완료의 정본은 **플래그**다(`resolveSettlementCompletionFlags` 와 같은 축). 쓰기
   * 경로(`resolveSettlementSync`)가 완료 취소 시 완료일을 함께 지우므로 어긋난 행은
   * 생기지 않지만, 판정 기준이 둘로 갈리지 않게 여기서 못 박는다.
   */
  it("완료 플래그가 꺼져 있으면 완료일이 남아 있어도 예정일을 쓴다", () => {
    const result = resolveMoneySlotEffectiveDate(sellerPayout, {
      expectedPayoutDate: "2026-08-20",
      payoutCompletedAt: "2026-08-15",
      isPayoutCompleted: false,
    });
    expect(result).toEqual({ date: "2026-08-20", isActual: false });
  });

  it("입금·공급사 지급도 같은 규칙이다 — 방향으로 갈리지 않는다", () => {
    expect(
      resolveMoneySlotEffectiveDate(slotOf("BRAND_MALL", "deposit"), {
        expectedDepositDate: "2026-09-10",
        depositReceivedAt: "2026-09-07",
        isDepositReceived: true,
      }),
    ).toEqual({ date: "2026-09-07", isActual: true });

    expect(
      resolveMoneySlotEffectiveDate(slotOf("OWN_MALL", "supplierPayout"), {
        expectedSupplierPayoutDate: "2026-09-25",
        supplierPayoutCompletedAt: "2026-09-24",
        isSupplierPayoutCompleted: true,
      }),
    ).toEqual({ date: "2026-09-24", isActual: true });
  });

  it("Date 를 넣으면 Date 가 그대로 나온다 — 서버 경로가 문자열로 변환하지 않는다", () => {
    const completed = new Date("2026-08-15T00:00:00.000Z");
    const result = resolveMoneySlotEffectiveDate(sellerPayout, {
      expectedPayoutDate: new Date("2026-08-20T00:00:00.000Z"),
      payoutCompletedAt: completed,
      isPayoutCompleted: true,
    });
    expect(result.date).toBe(completed);
    expect(result.isActual).toBe(true);
  });
});
