import type { CampaignRow } from "@/lib/crm-types";
// type-only import — 런타임 순환 의존 없음(tax-filing-board.ts 가 이 파일의
// validateTaxInvoiceCampaigns 를 값으로 import 하지만, 여기서 가져오는 건 타입뿐이라
// 컴파일 시 소거된다).
import type { TaxInvoiceBoardRow, TaxInvoiceCounterpart } from "@/lib/tax-filing-board";
// 값 import 지만 순환이 아니다 — `vat.ts` 는 아무것도 import 하지 않는 말단 모듈이다
// (보드를 직접 import 하면 순환: 보드 → 이 파일 → 보드).
import { splitVatIncluded } from "@/lib/vat";
// 홈택스 자유 텍스트 칸의 바이트 상한 — 말단 순수 모듈이라 순환이 아니다.
import { truncateToHometaxBytes } from "@/lib/hometax-text";

// ─────────────────────────────────────────────
// Data Models
// ─────────────────────────────────────────────

export interface LineItem {
  /**
   * DD (2자리) — 거래일자의 **일**. 작성일자와 같은 날이다(작성일자 = 공급 연월일).
   * 월은 홈택스가 작성일자에서 자동 반영하므로 우리가 넣지 않는다(넣을 수도 없다).
   */
  date: string;
  /** 품목명 */
  name: string;
  /** 규격 (옵션) */
  spec: string;
  /** 수량 (정수 10자리, 소수점 2자리 이내) */
  quantity: number;
  /** 단가 (정수 13자리, 소수점 2자리 이내) */
  unitPrice: number;
  /** 품목 공급가액 */
  supplyAmount: number;
  /** 품목 세액 */
  taxAmount: number;
  /** 품목 비고 */
  remark: string;
}

export interface TaxInvoiceRow {
  // A: 전자세금계산서 종류 (01 | 02)
  invoiceType: "01" | "02";

  // B: 작성일자 YYYYMMDD
  invoiceDate: string;

  // C~J: 공급자
  supplierBusinessNumber: string;    // 하이픈 없이 10자리
  supplierSubBusinessNumber: string; // 종사업장번호 (없으면 "")
  supplierName: string;
  supplierCeo: string;
  supplierAddress: string;
  supplierBusinessType: string;
  supplierBusinessItem: string;
  supplierEmail: string;             // 텍스트 전용

  // K~S: 공급받는자
  buyerBusinessNumber: string;       // 하이픈 없이 10자리
  buyerSubBusinessNumber: string;
  buyerName: string;
  buyerCeo: string;
  buyerAddress: string;
  buyerBusinessType: string;
  buyerBusinessItem: string;
  buyerEmail1: string;
  buyerEmail2: string;

  // T~V: 합계 및 비고
  totalSupplyAmount: number;
  totalTaxAmount: number;
  remark: string;

  // W(23)~BB(54): 품목 1~4 (각 8컬럼), 최대 4개
  //   품목1: W(23)~AD(30), 품목2: AE(31)~AL(38), 품목3: AM(39)~AT(46), 품목4: AU(47)~BB(54)
  lineItems: LineItem[];

  // BC(55)~BF(58): 현금, 수표, 어음, 외상미수금
  cash: number;
  check: number;
  note: number;
  credit: number;

  // BG(59): 영수(01) / 청구(02)
  paymentType: "01" | "02";
}

export interface SupplierInfo {
  businessNumber: string;
  subBusinessNumber: string;
  name: string;
  ceo: string;
  address: string;
  businessType: string;
  businessItem: string;
  email: string;
}

export interface ValidationError {
  campaignId: string;
  campaignName: string;
  missingFields: string[];
}

export type TaxInvoiceValidation =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

// ─────────────────────────────────────────────
// 공급자 고정 상수 (settlement-statement.ts의 YGRD_COMPANY와 동일 사업자)
// ─────────────────────────────────────────────

export const SUPPLIER = {
  businessNumber: "6866800667",
  subBusinessNumber: "",
  name: "와이그라운드",
  ceo: "정지수",
  address: "서울특별시 송파구 중대로9길 35, 6층 S22호(가락동)",
  businessType: "도매 및 소매업",
  businessItem: "전자상거래 중개 및 소매업, 공동구매",
  email: "info@ygrd.kr",
} as const satisfies SupplierInfo;

// ─────────────────────────────────────────────
// 순수 함수: 사업자등록번호 정규화
// ─────────────────────────────────────────────

/**
 * 하이픈, 공백 등 비숫자 문자를 제거하여 10자리 숫자 문자열로 반환한다.
 * 10자리가 되지 않는 입력은 그대로 반환(유효성 검사는 validateTaxInvoiceCampaigns에서 담당).
 *
 * Requirements: 5.5, 7.4
 */
export function normalizeBusinessNumber(raw: string): string {
  return raw.replace(/\D/g, "");
}

// ─────────────────────────────────────────────
// 순수 함수: 유효성 검사
// ─────────────────────────────────────────────

/**
 * 세금계산서 발행 전 캠페인 배열을 검증한다. `counterpart`로 어느 쪽 필드를
 * 볼지 가른다 — 공급받는자가 셀러(SELLER)면 셀러 사업자 필드, 공급사(SUPPLIER)면
 * `deal.partner` 사업자 필드(2026-08-04, `CampaignRow` 확장으로 노출됨).
 *
 * ⛔ 예전에는 이 함수가 셀러 필드만 봤다(counterpart 인자 자체가 없었다) —
 * `tax-filing-board.ts`가 SUPPLIER 상대 행(브랜드몰 발행·우리몰 수취)의 결번을
 * 판정할 수 없는 구멍이 있었다(스펙 「검증도 상대를 봐야 한다」절). 지금은 이
 * 함수 하나가 두 상대를 다 검증하므로 구멍이 닫혔다.
 *
 * ⛔ 예전엔 "동일 사업자등록번호로 그룹핑해 품목 4개 초과면 차단"하는 검사도
 * 했다 — 옛 `buildTaxInvoiceRows`가 같은 사업자의 캠페인 여러 건을 한 장의
 * 세금계산서로 합쳐 딜/캠페인을 품목으로 늘어놓던 모델의 제약이었다. 2026-08-04
 * 부터 `buildTaxInvoiceRows`는 `tax-filing-board`의 행을 그대로 소비하고, 한
 * 행(=캠페인 하나 또는 정산 그룹 하나)이 항상 품목 1개짜리 세금계산서 1장이 된다
 * — 사업자번호로 여러 캠페인을 다시 묶는 동작 자체가 없어졌으므로 그 검사도
 * 함께 제거한다(전제가 사라진 검사를 남겨두면 이제는 없는 배치 모델을 근거로
 * 정상 요청을 차단하게 된다).
 */
export function validateTaxInvoiceCampaigns(
  campaigns: CampaignRow[],
  counterpart: TaxInvoiceCounterpart = "SELLER",
): TaxInvoiceValidation {
  const errors: ValidationError[] = [];

  if (campaigns.length > 100) {
    errors.push({
      campaignId: "",
      campaignName: "",
      missingFields: [`최대 100건까지 선택 가능합니다. (현재 ${campaigns.length}건)`],
    });
    return { ok: false, errors };
  }

  for (const campaign of campaigns) {
    const missingFields: string[] = [];

    if (counterpart === "SUPPLIER") {
      if (!campaign.partnerBusinessNumber) missingFields.push("사업자등록번호");
      if (!campaign.partnerName) missingFields.push("상호");
      if (!campaign.partnerCeoName) missingFields.push("대표자명");
    } else {
      if (!campaign.sellerCompanyBusinessNumber) missingFields.push("사업자등록번호");
      if (!campaign.sellerCompanyName) missingFields.push("상호");
      if (!campaign.sellerCompanyCeoName) missingFields.push("대표자명");
      if ((campaign.sellerExpense ?? 0) <= 0) missingFields.push("정산금(sellerExpense)이 0 이하");
    }

    if (missingFields.length > 0) {
      errors.push({
        campaignId: campaign.id,
        campaignName: campaign.dealName,
        missingFields,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────
// 순수 함수: 캠페인 종료일 → 품목 일자(DD)
// ─────────────────────────────────────────────

/**
 * **작성일자 = 공급 연월일 = 캠페인 종료일**(오너 확정, 2026-08-06 재확정).
 *
 * ## 여기까지 온 경위 — 두 번 틀렸다
 *
 * ① 최초 구현은 작성일자를 **호출 시점(오늘)**으로 두고 품목 일자만
 *    `min(종료일, 작성일)`로 맞췄다. 지난달에 끝난 캠페인은 거래일자가 조용히
 *    오늘 날짜가 됐다.
 * ② 그걸 고치겠다며 품목의 **월**까지 넣으려 했다(2026-08-06 오전). 화면 덤프에
 *    월 입력칸이 있어서 「입력 가능」이라 단정했는데, **실측해 보니 disabled**였다 —
 *    화면이 「'품목'의 '월'은 상단 '작성일자'의 '월'이 자동 반영됩니다」라고 명시한다.
 *    같은 실측에서 **품목 일자가 작성일자보다 뒤면 홈택스가 조용히 지운다**는 것도
 *    확인했다(작성일자 08-06 에 일자 10 → 사라짐, 일자 05 → 유지).
 *
 * ## 그래서 규칙을 하나로 합쳤다
 *
 * 작성일자를 **공급 연월일로 소급**하면 나머지가 전부 따라온다 — 품목의 월은 그 달로
 * 자동 반영되고, 품목 일자는 작성일자와 같은 날이라 「일 ≤ 작성일」을 자동으로 만족하며,
 * **XLSX 에 월 칸이 없다는 제약도 문제가 되지 않는다**(교차월이 발생하지 않으므로).
 * 종전에 그 제약을 우회하려고 만든 장치(`LineItem.month`·`hasCrossMonthLineItem`·
 * `xlsxLineItemDay`·`isCrossMonthTransaction`)는 전부 필요 없어져 걷어냈다.
 *
 * ⚠️ **미래 날짜는 작성일자가 될 수 없다.** 아직 끝나지 않은 캠페인(종료일이 오늘보다
 * 뒤)은 오늘로 자른다 — 미래 작성일자는 홈택스가 받지 않는다.
 *
 * ⚠️ 이 선택은 **지연발급 가산세를 날짜로 정직하게 남기는** 쪽이다. 공급시기 익월
 * 10일을 넘겨 발행하면 지연발급인데, 작성일자를 발행 당일로 두면 그 사실이 가려진다.
 * 오너 판단(2026-08-06)이다.
 */
export function resolveInvoiceDate(endDateStr: string | null | undefined, today: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
  if (!endDateStr) return todayStr;
  const end = endDateStr.slice(0, 10).replace(/-/g, "");
  // 형식이 깨졌으면 지어내지 않고 오늘로 폴백한다(빈 작성일자는 발급이 막힌다).
  if (!/^\d{8}$/.test(end)) return todayStr;
  // YYYYMMDD 는 문자열 비교가 곧 날짜 비교다 — Date 로 왕복하며 시간대에 흔들리지 않는다.
  return end > todayStr ? todayStr : end;
}

/**
 * 품목명은 계산서에 그대로 찍히는 이름이라 말줄임표만 붙인다(같은 자리에 긴 문구를
 * 넣으면 이름이 통째로 밀려난다). 상한·인코딩의 근거는 `hometax-text.ts` 가 정본.
 */
const ITEM_NAME_TRUNCATION_MARKER = "…";

/**
 * ⛔ **품목 비고는 작성하지 않는다 (오너 확정 2026-08-09 — T-025 후속).**
 *
 * 종전에는 딜별 내역(`딜이름(N개), …`)을 비고에 실었고, T-025 에서 100바이트 상한
 * 초과로 발급이 막히자 **잘라서** 싣는 것으로 고쳤다. 그러나 오너 실사용 판정은
 * "잘라도 품목이 많으면 결국 길어진다 — 아예 쓰지 말라"였다. 딜별 내역은 CRM 이
 * 정본으로 갖고 있으므로 계산서 비고에 복사할 이유가 없다.
 *
 * 그래서 `buildRemark`(딜 내역 조합 함수)는 **삭제됐다 — 되살리지 말 것.** 비고를
 * 다시 싣자는 제안은 이 결정을 뒤집는 것이므로 오너 승인 사안이다. 품목명 캡
 * (`truncateToHometaxBytes`)은 그대로다 — 캠페인 라벨은 여전히 우리가 채운다.
 */

// ─────────────────────────────────────────────
// 품목 행 — 상품·수수료 1행 + 부가 항목 N행 (설계 §3-3·§9-5)
// ─────────────────────────────────────────────

/**
 * ⛔ **홈택스 XLSX 의 품목 상한은 4개이고, 이건 취향이 아니라 물리적 제약이다.**
 *
 * 품목 i 는 컬럼 `23 + i*8` 에서 시작하는데 `23 + 4*8 = 55` 이고 **55번 칸이 현금**이다
 * (56~59 = 수표·어음·외상미수금·영수/청구). 즉 5번째 품목을 쓰면 결제 구분 5칸을
 * 통째로 덮어쓴 파일이 만들어진다 — 홈택스가 반려하거나, 더 나쁘게는 엉뚱한 결제
 * 구분으로 접수된다. 종전에는 품목이 항상 1개라 드러나지 않았고, 품목 행을 나누는
 * 2-A 가 이 결함을 실화로 만든다(설계 §9-6-1).
 *
 * TSV 는 품목 개수 제한이 없지만 **같은 상한을 적용한다** — 포맷마다 다른 계산서가
 * 나오면 오너가 어느 파일을 올렸는지에 따라 신고 내용이 갈린다.
 */
export const MAX_LINE_ITEMS = 4;

/** 품목명이 비어 있을 때의 폴백 — 빈 품목명은 홈택스가 받지 않는다. */
const ITEM_NAME_FALLBACK = "부가 항목";

/**
 * 행 하나를 품목 행들로 편다.
 *
 * ## 구성
 *
 * - **1행 = 주 품목**(상품 매출 또는 수수료). 품목명은 캠페인 라벨.
 * - **2행~ = 부가 항목**(광고비·반품배송비 등). 품목명은 오너가 적은 비고.
 *
 * 오너 확정 규약이다(설계 §3-3): *"1행에는 상품 매출에 대한 내역, 2행에는 부대비용에
 * 대한 내역을 입력해서 발행하는 식."* 계산서는 **1건으로 합산 발행**하되 거래 내역만
 * 나눈다.
 *
 * ## 잔차는 주 품목이 흡수한다 (오너 확정 2026-08-08)
 *
 * 품목별로 `/1.1` 을 하면 그 합이 행 총계와 1~2원 갈릴 수 있는데, 홈택스는 「품목 합 =
 * 총계」를 요구한다. 부가 항목 행은 **오너가 입력한 금액이 정확히 보여야** 하므로
 * (오너가 그 숫자로 대사한다) 주 품목이 차액을 먹는다 — 주 품목 금액은 애초에
 * 「총액 − 부가 항목」이라는 파생값이라 잔차를 얹어도 뜻이 흐려지지 않는다.
 *
 * ## 4개 초과분은 한 행으로 묶는다 (오너 확정 2026-08-08)
 *
 * 상한에 걸려 발급이 막히면 오너가 홈택스 앞에서 멈춘다. 개별 내역은 비고에 이미
 * 실려 있으므로, 초과분을 합계 한 행으로 접어 **항상 발급 가능**하게 한다.
 */
export function buildInvoiceLineItems(input: {
  /** 주 품목의 이름 — 캠페인 라벨(그룹이면 「대표 외 N건」). */
  mainName: string;
  /** 이 계산서의 **총계**(공급가액·세액). 품목 합이 반드시 이 값과 같아야 한다. */
  amount: { supplyAmount: number; taxAmount: number };
  /** 원금에 가산된 부가 항목(VAT 포함, 부호 있음) — `SettlementItemEffect.applied`. */
  appliedItems: ReadonlyArray<{ note: string | null; amount: number }>;
  /** 거래일자 DD. 표시 전용 호출부(도우미 다이얼로그)는 생략할 수 있다. */
  date?: string;
}): LineItem[] {
  const { mainName, amount, appliedItems: applied } = input;

  const base = (overrides: Partial<LineItem>): LineItem => ({
    date: input.date ?? "",
    // 품목명도 홈택스 바이트 상한을 받는다 — 그룹 라벨(「대표 외 N건」)이나 오너가 적은
    // 부가 항목 비고가 길면 여기서 튕긴다(T-025). 캡은 비고와 같은 곳에서 온다.
    name: truncateToHometaxBytes(mainName, ITEM_NAME_TRUNCATION_MARKER),
    spec: "",
    // 그룹·캠페인 단위 합산 품목 — 수량은 작성하지 않는다(기존 관행).
    quantity: 0,
    unitPrice: 0,
    supplyAmount: 0,
    taxAmount: 0,
    remark: "",
    ...overrides,
  });

  if (applied.length === 0) {
    // 부가 항목이 없으면 **현행과 바이트 동일**하다 — 착지 시 동작 변화 0(설계 §9-7-7).
    return [
      base({
        supplyAmount: amount.supplyAmount,
        taxAmount: amount.taxAmount,
      }),
    ];
  }

  // 주 품목이 1칸을 쓰므로 부가 항목에 남는 칸은 `MAX_LINE_ITEMS - 1`.
  const itemSlots = MAX_LINE_ITEMS - 1;
  const shown =
    applied.length <= itemSlots
      ? applied
      : [
          ...applied.slice(0, itemSlots - 1),
          {
            note: `${ITEM_NAME_FALLBACK} ${applied.length - (itemSlots - 1)}건`,
            amount: applied
              .slice(itemSlots - 1)
              .reduce((sum, item) => sum + item.amount, 0),
          },
        ];

  const itemRows = shown.map((item) =>
    base({
      // ⚠️ `base` 의 캡은 `overrides` 가 덮으므로 여기서 다시 건다 — 부가 항목 이름은
      //    오너가 자유롭게 적는 값이라 오히려 이쪽이 길어지기 쉽다.
      name: truncateToHometaxBytes(
        item.note?.trim() || ITEM_NAME_FALLBACK,
        ITEM_NAME_TRUNCATION_MARKER,
      ),
      ...splitVatIncluded(item.amount),
    }),
  );

  // 잔차 흡수 — 주 품목은 「총계 − 부가 항목 행들」이다. 두 칸(공급가액·세액)을 각각
  // 빼야 한다(세액을 공급가액에서 다시 유도하면 또 반올림이 낀다).
  const mainRow = base({
    supplyAmount: amount.supplyAmount - itemRows.reduce((sum, i) => sum + i.supplyAmount, 0),
    taxAmount: amount.taxAmount - itemRows.reduce((sum, i) => sum + i.taxAmount, 0),
  });

  return [mainRow, ...itemRows];
}

// ─────────────────────────────────────────────
// 순수 함수: TaxInvoiceBoardRow[] → TaxInvoiceRow[]
// ─────────────────────────────────────────────

/**
 * `tax-filing-board.buildTaxInvoiceObligationRows`(또는 `buildTaxInvoiceWorkBoard`)가
 * 낸 행에서 세금계산서를 만든다 — 캠페인에서 금액·상대를 다시 유도하지 않는다.
 *
 * ⛔ 예전 버전은 `CampaignRow[]`를 받아 사업자등록번호로 그룹핑하고, 공급받는자를
 * `sellerCompany*`로 하드코딩하고, 금액을 `sellerExpense`(딜 4개 이하) 또는
 * `actualSales`(초과)에서 다시 계산했다 — 스펙 「⛔ 채널별 세금계산서 거래 구조」
 * 표와 어긋나는 세 가지 오류였다(브랜드몰 발행의 공급받는자가 항상 셀러로 나옴,
 * 셀러몰 발행이 셀러 수수료 전액만큼 과다청구, 같은 캠페인이 딜 개수에 따라 다른
 * 금액을 냄). 화면(보드)과 파일(이 함수)이 같은 사실을 각자 계산해 갈린 것이
 * 원인이었다 — 이 도메인이 여섯 번 정정된 패턴 그대로다. 지금은 보드가 이미
 * counterpart·direction·amount·그룹 수렴·결번 판정을 전부 통과시킨 행을 그대로
 * 쓰므로 그 갈림이 구조적으로 사라진다.
 *
 * - `direction !== "ISSUE"`인 행(RECEIVE)은 상대가 발행하므로 건너뛴다 — 우리는
 *   추적만 한다(스펙 「따라오는 결론」#1).
 * - `row.amount`를 그대로 쓴다(재계산 금지) — 그룹 행이면 이미 멤버 전원의 원금을
 *   합산한 뒤 한 번만 반올림한 값이다.
 * - 품목은 `row.campaignLabel`(캠페인명 또는 "대표 멤버 외 N건")을 품목명으로 한
 *   단일 품목이다 — 합계가 행 금액과 정확히 일치함이 자명하다(홈택스 규칙).
 *   딜별 내역은 비고에 싣는다.
 * - 공급받는자는 `row.counterpart`로 가른다 — SELLER면 셀러 회사, SUPPLIER면
 *   대표 캠페인의 `deal.partner`(스펙 「CampaignRow 확장」).
 *
 * `campaignsById`는 행이 가리키는 캠페인의 원본 데이터(공급받는자 상세 필드,
 * 딜 내역)를 찾는 조회 테이블이다 — 호출부(route)가 이미 DB에서 조회한
 * `CampaignRow[]`를 id로 인덱싱해 넘긴다.
 */
export function buildTaxInvoiceRows(
  rows: TaxInvoiceBoardRow[],
  campaignsById: Map<string, CampaignRow>,
  invoiceDate: Date = new Date(),
): TaxInvoiceRow[] {

  return rows
    .filter((row) => row.direction === "ISSUE")
    .map((row) => {
      const anchor = campaignsById.get(row.campaignId);
      if (!anchor) {
        throw new Error(`행 "${row.campaignLabel}"이 가리키는 캠페인(${row.campaignId})을 찾을 수 없습니다.`);
      }

      const buyer =
        row.counterpart === "SUPPLIER"
          ? {
              businessNumber: normalizeBusinessNumber(anchor.partnerBusinessNumber ?? ""),
              name: anchor.partnerName,
              ceo: anchor.partnerCeoName ?? "",
              address: anchor.partnerAddress ?? "",
              businessType: anchor.partnerBusinessType ?? "",
              businessItem: anchor.partnerBusinessItem ?? "",
              email: anchor.partnerEmail ?? "",
            }
          : {
              businessNumber: normalizeBusinessNumber(anchor.sellerCompanyBusinessNumber ?? ""),
              name: anchor.sellerCompanyName ?? anchor.sellerName,
              ceo: anchor.sellerCompanyCeoName ?? "",
              address: anchor.sellerCompanyAddress ?? "",
              businessType: anchor.sellerCompanyBusinessType ?? "",
              businessItem: anchor.sellerCompanyBusinessItem ?? "",
              email: anchor.sellerCompanyEmail ?? "",
            };

      // 행마다 자기 작성일자를 갖는다 — 캠페인 종료일이 다르면 계산서 날짜도 다르다.
      const invoiceDateStr = resolveInvoiceDate(anchor.endDate, invoiceDate);
      const lineItems = buildInvoiceLineItems({
        mainName: row.campaignLabel,
        amount: row.amount,
        appliedItems: row.settlementItemEffect.applied,
        date: invoiceDateStr.slice(6, 8),
        // ⛔ 비고 미작성(오너 확정 2026-08-09) — 위 ITEM_NAME_TRUNCATION_MARKER 주석 참조.
        //    딜별 내역을 다시 실으려면 오너 승인이 먼저다.
      });

      return {
        invoiceType: "01",
        invoiceDate: invoiceDateStr,

        supplierBusinessNumber: SUPPLIER.businessNumber,
        supplierSubBusinessNumber: SUPPLIER.subBusinessNumber,
        supplierName: SUPPLIER.name,
        supplierCeo: SUPPLIER.ceo,
        supplierAddress: SUPPLIER.address,
        supplierBusinessType: SUPPLIER.businessType,
        supplierBusinessItem: SUPPLIER.businessItem,
        supplierEmail: SUPPLIER.email,

        buyerBusinessNumber: buyer.businessNumber,
        buyerSubBusinessNumber: "",
        buyerName: buyer.name,
        buyerCeo: buyer.ceo,
        buyerAddress: buyer.address,
        buyerBusinessType: buyer.businessType,
        buyerBusinessItem: buyer.businessItem,
        buyerEmail1: buyer.email,
        buyerEmail2: "",

        // 합계는 행 금액 그대로다(품목이 그 금액에서 파생됐으므로 자명하게 일치한다)
        // — 재계산·재합산하지 않는다(재계산이 바로 이 함수가 고친 그 오류다).
        totalSupplyAmount: row.amount.supplyAmount,
        totalTaxAmount: row.amount.taxAmount,
        remark: "",

        lineItems,

        cash: 0,
        check: 0,
        note: 0,
        credit: 0,

        paymentType: "02",
      };
    });
}

// ─────────────────────────────────────────────
// TSV 빌더 (홈택스 TAB 구분 텍스트 일괄등록 형식)
// ─────────────────────────────────────────────

/**
 * TaxInvoiceRow 배열을 홈택스 TAB 구분 텍스트 형식으로 변환한다.
 * 
 * 홈택스 TAB 구분 형식 장점:
 * - 품목 개수 제한 없음 (XLSX는 4개 제한)
 * - 더 간단한 파일 구조
 * - 홈택스에서 직접 지원
 * 
 * 컬럼 순서 (TAB으로 구분):
 * 1. 전자세금계산서 종류 (01: 일반, 02: 영세율)
 * 2. 작성일자 (YYYYMMDD)
 * 3. 공급자 등록번호 (10자리)
 * 4. 공급자 종사업장번호 (4자리, 없으면 공백)
 * 5. 공급자 상호
 * 6. 공급자 성명 (대표자명)
 * 7. 공급자 사업장주소
 * 8. 공급자 업태
 * 9. 공급자 종목
 * 10. 공급자 이메일
 * 11. 공급받는자 등록번호
 * 12. 공급받는자 종사업장번호
 * 13. 공급받는자 상호
 * 14. 공급받는자 성명
 * 15. 공급받는자 사업장주소
 * 16. 공급받는자 업태
 * 17. 공급받는자 종목
 * 18. 공급받는자 이메일1
 * 19. 공급받는자 이메일2
 * 20. 공급가액 합계
 * 21. 세액 합계
 * 22. 비고
 * 23~N. 품목 정보 (일자, 품목명, 규격, 수량, 단가, 공급가액, 세액, 비고) * N개
 * N+1. 현금
 * N+2. 수표
 * N+3. 어음
 * N+4. 외상미수금
 * N+5. 영수/청구 구분 (01: 영수, 02: 청구)
 * 
 * Requirements: 5.1, 5.5, 5.6, 6.2
 */
export function buildTaxInvoiceTsv(rows: TaxInvoiceRow[]): string {
  const lines: string[] = [];

  for (const row of rows) {
    const fields: string[] = [
      // 1~10: 기본 정보 및 공급자
      row.invoiceType,
      row.invoiceDate,
      row.supplierBusinessNumber,
      row.supplierSubBusinessNumber,
      row.supplierName,
      row.supplierCeo,
      row.supplierAddress,
      row.supplierBusinessType,
      row.supplierBusinessItem,
      row.supplierEmail,

      // 11~19: 공급받는자
      row.buyerBusinessNumber,
      row.buyerSubBusinessNumber,
      row.buyerName,
      row.buyerCeo,
      row.buyerAddress,
      row.buyerBusinessType,
      row.buyerBusinessItem,
      row.buyerEmail1,
      row.buyerEmail2,

      // 20~22: 합계 및 비고
      String(row.totalSupplyAmount),
      String(row.totalTaxAmount),
      row.remark,
    ];

    // 23~N: 품목 정보 (각 품목당 8개 필드)
    for (const item of row.lineItems) {
      fields.push(
          item.date,
        item.name,
        item.spec,
        String(item.quantity),
        String(item.unitPrice),
        String(item.supplyAmount),
        String(item.taxAmount),
        item.remark,
      );
    }

    // N+1~N+5: 현금/수표/어음/외상미수금/영수청구
    fields.push(
      String(row.cash),
      String(row.check),
      String(row.note),
      String(row.credit),
      row.paymentType,
    );

    lines.push(fields.join("\t"));
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────
// XLSX 빌더 (Node.js 전용 — exceljs)
// ─────────────────────────────────────────────

/**
 * TaxInvoiceRow 배열을 홈택스 일괄 업로드 규격 XLSX Buffer로 변환한다.
 * 1~6행 비움, 7행부터 데이터 삽입.
 * 이메일·사업자등록번호 셀은 텍스트 형식(numFmt: "@")으로 강제.
 *
 * Requirements: 5.1, 5.5, 5.6, 6.2
 */
export async function buildTaxInvoiceXlsx(rows: TaxInvoiceRow[]): Promise<Buffer> {
  // Dynamic import — exceljs is a Node.js-only dependency
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("세금계산서");

  const TEXT_FMT = "@";
  const AMOUNT_FMT = "#,##0";
  const DATA_START_ROW = 7;

  rows.forEach((row, idx) => {
    const rowNum = DATA_START_ROW + idx;
    const exRow = sheet.getRow(rowNum);

    // Helper: set cell value + optional numFmt
    function setCell(col: number, value: string | number, numFmt?: string) {
      const cell = exRow.getCell(col);
      cell.value = value;
      if (numFmt) {
        cell.numFmt = numFmt;
      }
    }

    // A: 종류코드
    setCell(1, row.invoiceType, TEXT_FMT);
    // B: 작성일자
    setCell(2, row.invoiceDate, TEXT_FMT);

    // C~J: 공급자
    setCell(3, row.supplierBusinessNumber, TEXT_FMT);      // C
    setCell(4, row.supplierSubBusinessNumber, TEXT_FMT);   // D
    setCell(5, row.supplierName);                          // E
    setCell(6, row.supplierCeo);                           // F
    setCell(7, row.supplierAddress);                       // G
    setCell(8, row.supplierBusinessType);                  // H
    setCell(9, row.supplierBusinessItem);                  // I
    setCell(10, row.supplierEmail, TEXT_FMT);              // J

    // K~S: 공급받는자
    setCell(11, row.buyerBusinessNumber, TEXT_FMT);        // K
    setCell(12, row.buyerSubBusinessNumber, TEXT_FMT);     // L
    setCell(13, row.buyerName);                            // M
    setCell(14, row.buyerCeo);                             // N
    setCell(15, row.buyerAddress);                         // O
    setCell(16, row.buyerBusinessType);                    // P
    setCell(17, row.buyerBusinessItem);                    // Q
    setCell(18, row.buyerEmail1, TEXT_FMT);                // R
    setCell(19, row.buyerEmail2, TEXT_FMT);                // S

    // T~V: 합계 및 비고
    setCell(20, row.totalSupplyAmount, AMOUNT_FMT);        // T
    setCell(21, row.totalTaxAmount, AMOUNT_FMT);           // U
    setCell(22, row.remark);                               // V

    // 품목 (각 8컬럼) — 품목 i: 컬럼 (23 + i*8) ~ (23 + i*8 + 7)
    //
    // ⛔ **상한을 넘기면 조용히 자르지 않고 던진다.** `23 + 4*8 = 55` 는 현금 칸이라
    //    5번째 품목은 결제 구분 5칸(BC~BG)을 덮어쓴다 — 그 파일은 반려되거나, 더
    //    나쁘게는 엉뚱한 결제 구분으로 접수된다. 잘라 내는 것도 답이 아니다: 품목 합이
    //    총계와 어긋나 역시 반려되고, 그 사실이 **아무 데도 안 보인다.**
    //    정상 경로(`buildLineItems`)는 이미 4개로 접어 오므로 여기 걸리는 것은 호출부가
    //    직접 만든 행뿐이다 — 그때는 코드 결함이니 시끄럽게 실패하는 것이 맞다(P0).
    if (row.lineItems.length > MAX_LINE_ITEMS) {
      throw new Error(
        `세금계산서 품목이 ${row.lineItems.length}개입니다. 홈택스 XLSX 는 최대 ${MAX_LINE_ITEMS}개까지만 실을 수 있습니다(초과분은 합계 한 행으로 묶어야 합니다).`,
      );
    }
    const numItems = row.lineItems.length;
    for (let i = 0; i < numItems; i++) {
      const baseCol = 23 + i * 8;
      const item = row.lineItems[i];
      // 일자: "01"~"31" 텍스트 형식. 월은 작성일자에서 정해지고, 작성일자 = 공급
      // 연월일이므로 이 일자와 같은 달이다(교차월이 생기지 않는다).
      setCell(baseCol,     item.date, TEXT_FMT);
      setCell(baseCol + 1, item.name);
      setCell(baseCol + 2, item.spec);
      setCell(baseCol + 3, item.quantity);
      setCell(baseCol + 4, item.unitPrice, AMOUNT_FMT);
      setCell(baseCol + 5, item.supplyAmount, AMOUNT_FMT);
      setCell(baseCol + 6, item.taxAmount, AMOUNT_FMT);
      setCell(baseCol + 7, item.remark);
    }

    // BC(55)~BF(58): 현금, 수표, 어음, 외상미수금 (홈택스 고정 컬럼)
    // BG(59): 영수/청구 구분
    setCell(55, row.cash,   AMOUNT_FMT);        // BC: 현금
    setCell(56, row.check,  AMOUNT_FMT);        // BD: 수표
    setCell(57, row.note,   AMOUNT_FMT);        // BE: 어음
    setCell(58, row.credit, AMOUNT_FMT);        // BF: 외상미수금
    setCell(59, row.paymentType, TEXT_FMT);     // BG: 영수/청구

    exRow.commit();
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
