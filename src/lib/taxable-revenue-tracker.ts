/**
 * 네이버 판매자 등급 「과세기준매출」 트래커 — 순수·client-safe(`now` 주입).
 *
 * 설계 정본: `docs/private/specs/2026-09-29-taxable-revenue-tracker-design.md`(로컬 서고).
 *
 * ## 무엇을 답하나
 *
 * 네이버페이 주문관리수수료는 **국세청 신고 매출(부가세 과세표준, 전 채널 합산)** 로 정해지는
 * 판매자 등급에 따라 차등이고, 등급은 연 2회(2/14 · 8/14) 갱신된다. 이 모듈은 「다음 갱신의
 * 기준기간에 CRM 캠페인이 쌓은 과세 매출이 지금 얼마이고, 등급 기준선까지 얼마 남았으며, 넘으면
 * 수수료가 얼마 늘어나는가」를 계산한다. 화면은 홈 대시보드 카드 하나다.
 *
 * ## 현재 등급도 CRM 으로 추정한다
 *
 * 현재 등급을 소스에 상수로 적지 않는다(공개 레포 — 등급은 매출 구간을 드러낸다). 대신 **직전
 * 갱신의 기준기간**을 같은 규칙으로 누적해 등급으로 환산한다(`resolvePreviousGradeUpdate`).
 * CRM 밖 매출·CRM 도입 이전 기간이 빠지므로 추정치이고, 화면은 「현재 등급(CRM 추정)」으로 표시한다.
 *
 * ## 채널별 과세 매출(캠페인 1건, VAT 포함 원화)
 *
 * | 채널 | 과세 매출 |
 * | --- | --- |
 * | 자사몰 3종(`OWN_MALL*`) | `actualSales` 전액(소비자 직접 판매) |
 * | 브랜드몰 | `computeBaseAmountForBasis("SETTLEMENT_SALES")` — 브랜드사에 발행하는 영업수익 계산서 |
 * | 셀러몰 | `computeBaseAmountForBasis("SALES_MINUS_COMMISSION")` — 셀러에게 발행하는 **판매액−셀러수수료 전체** |
 * | 미지정 | 범위(하한 = 브랜드몰 산식 · 상한 = `actualSales`) — 여유 판정엔 **상한**(보수적) |
 *
 * ⛔ 금액 기준을 여기서 다시 계산하지 말 것 — 세무 보드의 SSOT(`computeBaseAmountForBasis`)를
 * 그대로 부른다. 같은 계산서 금액을 두 곳에서 따로 만들면 이 도메인이 여섯 번 겪은 「두 번째
 * 인코딩」 사고가 된다.
 *
 * ⛔ **`UNSPECIFIED` 를 `resolveTaxFilingChannelGroup` 에 넣지 말 것.** 그 함수는 미지정을
 * 셀러몰로 떨어뜨린다(체크리스트 분기와 바이트 단위로 맞춰야 하는 세무 보드의 사정) — 이
 * 트래커에서는 그게 오분류라서, 미지정은 **판정 전에** 따로 가른다.
 *
 * ## 「모름」은 0 이 아니다
 *
 * 결번(`blockingReasons` 가 비어 있지 않음)이나 `actualSales` null 인 캠페인은 합계에 0 으로
 * 섞지 않고 **「금액 미입력」 건수**로 센다 — 0 으로 섞으면 여유가 실제보다 커 보이는 방향으로
 * 틀린다(가장 위험한 방향). 미지정의 **하한**만 예외적으로 결번을 0 으로 둔다: 하한은 여유
 * 판정에 쓰이지 않는 표시용 범위이고, 0 은 그 자체로 유효한 하한이다.
 *
 * ## 공급가액이 1차 기준이다
 *
 * 과세표준은 VAT 제외라는 가정(⚠️ 미확인 가정 — 네이버 원문 미확인)으로 기준선 비교는
 * **공급가액**으로 하고, VAT 포함 기준 여유는 보조로 낸다. 변환은 `splitVatIncluded`(vat.ts,
 * 레포 유일 변환 지점)를 합계에 **한 번만** 적용한다.
 *
 * ## 귀속 기간(부가세 반기) — 채널마다 다르다
 *
 * - **자사몰 3종**: 소비자 카드·PG 매출이라 과세 시점은 **판매일**이다. 캠페인 종료일로 통째로
 *   귀속하면 12/26~1/1 캠페인의 12월 매출이 전부 다음 해로 넘어가, 기준선 근처라면 판정이
 *   뒤집힐 수 있다. 그래서 `actualSales` 를 [startDate, endDate]
 *   의 **KST 달력 일수**로 안분해 기준기간 안 일수 비율만큼만 넣는다(일별 매출이 균등하다는
 *   근사 — 실제 일별 매출은 이 로더에 없다). 넘었을 때 비용의 표본 창도 같은 안분을 쓴다.
 * - **브랜드몰·셀러몰·미지정**: 세금계산서 기반이라 `endDate` 의 **KST 날짜**가 속한 반기
 *   (1기=1~6월, 2기=7~12월)에 통째로 귀속한다 — 세금계산서 작성일자 = 캠페인 종료월 관례.
 *   반기 경계를 걸친 캠페인은 오차가 난다(알려진 한계).
 * - 시작일이 종료일보다 늦은 잘못된 기간은 **종료일 하루**로 본다(안분 분모가 0·음수가 되지 않게).
 *
 * ## 「아직 안 끝남」은 「미입력」이 아니다
 *
 * 금액을 모르는 캠페인이라도 종료일(KST)이 오늘 이후면 매출이 아직 안 들어온 것이지 입력
 * 누락이 아니다 — `pendingCount`(「진행·예정」)로 따로 세고, `missingCount`(「금액 미입력」)는
 * 끝난 캠페인만 센다. 둘 다 합계에는 0 으로 섞지 않는다(여유가 더 줄어들 수 있다는 뜻이다).
 *
 * 갱신과 기준기간(개인사업자, KST 날짜 판정):
 * - 2/14 갱신의 기준 = 그 직전 달력연도(1기+2기).
 * - 8/14 갱신의 기준 = 전년 2기 + 당해 1기. ⚠️ **미확인 가정**(외부 조사만, 원문 미확인)
 *   — 결과에 `assumed: true` 로 싣고 화면이 그 사실을 표시한다.
 * - 다음 갱신: 8/14 ~ 익년 2/13 → 다음 2/14 · 2/14 ~ 8/13 → 8/14.
 * - 직전 갱신: 2/14 ~ 8/13 → 당해 2/14 · 8/14 ~ 12/31 → 당해 8/14 · 1/1 ~ 2/13 → 전년 8/14.
 *
 * ## 넘었을 때 비용
 *
 * 네이버 자사몰(`OWN_MALL_NAVER`) 최근 6개월 `actualSales` 합 × 요율 차. 6개월 창 `(오늘 − 6개월,
 * 오늘]` 과 캠페인 기간이 겹치는 **KST 일수 비율로 안분**한다(위 자사몰 귀속과 같은 근사).
 * **네이버페이 결제분만**이다 — 카카오 등 다른 PG 자사몰은 이 수수료와 무관해 넣지 않는다.
 */

import {
  computeBaseAmountForBasis,
  resolveTaxFilingChannelGroup,
  type InvoiceBaseAmountInput,
} from "./tax-filing-board";
import { toKstYmd } from "./date-utils";
import { splitVatIncluded } from "./vat";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/**
 * 네이버 판매자 등급표 — 기준선(공급가액, 원)과 주문관리수수료율(VAT 포함).
 *
 * 요율 단위는 **0.001%p 정수**(`feeRateMilliPercent`) — 1.947% = 1947. 부동소수로 요율 차를
 * 빼면 0.0061600000000000005 같은 값이 비용 계산에 새어 나온다.
 *
 * 출처: 네이버페이센터 공개 주문관리수수료(VAT 포함), 2026-09 기준 조사값 · ⚠️ 원문 재확인 필요.
 * 구간(영세 ≤3억 / 중소1 3~5억 / 중소2 5~10억 / 중소3 10~30억 / 일반 >30억)도 같은 조사값이다.
 * 경계값은 「이하」가 아래 등급이다(정확히 3억이면 영세).
 */
export const NAVER_SELLER_GRADES = [
  { key: "MICRO", label: "영세", upperSupply: 300_000_000, feeRateMilliPercent: 1947 },
  { key: "SMALL1", label: "중소1", upperSupply: 500_000_000, feeRateMilliPercent: 2563 },
  { key: "SMALL2", label: "중소2", upperSupply: 1_000_000_000, feeRateMilliPercent: 2728 },
  { key: "SMALL3", label: "중소3", upperSupply: 3_000_000_000, feeRateMilliPercent: 3003 },
  { key: "GENERAL", label: "일반", upperSupply: null, feeRateMilliPercent: 3630 },
] as const;

export type NaverSellerGrade = (typeof NAVER_SELLER_GRADES)[number];
export type NaverSellerGradeKey = NaverSellerGrade["key"];

/** 과세 매출에서 제외하는 캠페인 상태 — 성사되지 않은 제안·보류(드랍)는 매출이 없다. */
export const TAXABLE_REVENUE_EXCLUDED_STATUSES = ["PROPOSAL", "DROPPED"] as const;

/**
 * 「기준선 근접」 판정 비율 — 여유가 기준선의 10% 이하이면 근접(주의색).
 * ⚠️ 설계서에 수치가 없어 구현이 정한 값이다(3억 기준선이면 여유 3천만 원 이하).
 */
export const NEAR_THRESHOLD_RATIO = 0.1;

/** 넘었을 때 비용의 표본 기간(개월) — 네이버 자사몰 최근 N개월 매출. 등급 유효기간(반년)과 같다. */
export const CROSSING_COST_LOOKBACK_MONTHS = 6;

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export type TaxableChannelGroup = "OWN_MALL" | "BRAND_MALL" | "SELLER_MALL" | "UNSPECIFIED";

/** 캠페인 1건 입력 — 로더가 Decimal 을 number 로 풀어서 넘긴다. */
export type TaxableRevenueCampaignInput = InvoiceBaseAmountInput & {
  salesChannel: string | null;
  status: string;
  /** 자사몰 매출의 일수 안분에만 쓴다(그 외 채널은 종료일 귀속). */
  startDate: Date;
  endDate: Date;
};

export type VatHalf = { year: number; half: 1 | 2 };

export type TaxableRevenueReferencePeriod = {
  halves: VatHalf[];
  /** KST 날짜 `YYYY-MM-DD` — 기준기간 첫날 · 마지막날. */
  startYmd: string;
  endYmd: string;
  /** 예: 「2026년 1기+2기」 · 「2025년 2기 + 2026년 1기」 */
  label: string;
  /** true 면 8월 갱신 기준기간 — 원문 미확인 가정이다. */
  assumed: boolean;
};

export type TaxableGradeView = {
  key: NaverSellerGradeKey;
  label: string;
  upperSupply: number | null;
  feeRateMilliPercent: number;
};

export type TaxableChannelSubtotal = {
  /** 합계에 들어간 캠페인 수(금액 미입력 제외). */
  count: number;
  /** **끝난** 캠페인 중 금액 미입력(결번·actualSales null) 수 — 합계에 0 으로 섞지 않았다. */
  missingCount: number;
  /** 아직 안 끝난(종료일 KST > 오늘) 캠페인 중 금액을 모르는 수 — 입력 누락이 아니라 매출 미반영. */
  pendingCount: number;
  /** VAT 포함 합계. 미지정은 **상한**(보수적). */
  vatIncluded: number;
  supply: number;
};

export type TaxableUnspecifiedSubtotal = TaxableChannelSubtotal & {
  /** 하한(브랜드몰 산식) VAT 포함 합계 — 표시용 범위. */
  lowerVatIncluded: number;
  lowerSupply: number;
};

export type TaxableRevenueStatus = "WITHIN" | "NEAR" | "OVER";

export type TaxableCrossingCost = {
  /**
   * `IF_CROSSED` — 아직 안 넘었다: 다음 등급으로 올라가면 늘어나는 비용.
   * `ALREADY_OVER` — 현재 등급 기준선을 이미 넘었다: 추정대로 갱신되면 늘어나는 비용.
   */
  kind: "IF_CROSSED" | "ALREADY_OVER";
  from: TaxableGradeView;
  to: TaxableGradeView;
  /** 네이버 자사몰 최근 6개월 actualSales 합(VAT 포함). */
  naverOwnMallSales: number;
  /** 그 기간 네이버 자사몰 중 **끝난** 캠페인의 actualSales 미입력 건수 — 합에서 빠졌다. */
  naverOwnMallMissingCount: number;
  /** 반년 예상 추가 수수료(원, 반올림). */
  amount: number;
};

export type TaxableRevenueTracker = {
  asOfYmd: string;
  /** 다음 등급 갱신일 KST `YYYY-MM-DD`. */
  nextUpdateYmd: string;
  referencePeriod: TaxableRevenueReferencePeriod;
  /**
   * 현재 등급 — 상수가 아니라 **직전 갱신 기준기간의 CRM 누적**으로 추정한 값이다(모듈 헤더
   * 「현재 등급도 CRM 으로 추정한다」). 화면은 「현재 등급(CRM 추정)」으로 표시한다.
   */
  currentGrade: TaxableGradeView;
  currentGradeEstimated: true;
  /** 현재 등급 추정의 근거 — 직전 갱신일과 그 기준기간, 그 기간 누적(보수적 공급가액). */
  previousGradeUpdate: {
    updateYmd: string;
    referencePeriod: TaxableRevenueReferencePeriod;
    cumulativeSupply: number;
  };
  /** 누적(보수적 상한)이 속한 등급 = 다음 갱신 때 예상 등급. */
  estimatedGrade: TaxableGradeView;
  status: TaxableRevenueStatus;
  /**
   * 화면의 기준선(공급가액). WITHIN·NEAR = 누적이 속한 등급의 상한, OVER = **현재 등급**의
   * 상한(넘은 선). 일반 등급(상한 없음)이면 null.
   */
  thresholdSupply: number | null;
  /** WITHIN·NEAR: 기준선까지 남은 공급가액. OVER·일반: null. */
  headroomSupply: number | null;
  /** OVER: 현재 등급 기준선을 넘은 공급가액. 그 외 null. */
  overSupply: number | null;
  /** OVER: 다음 기준선(예상 등급 상한)까지 남은 공급가액. 그 외 null. */
  nextThresholdHeadroomSupply: number | null;
  /** 기준선 − VAT 포함 누적(부호 있음, 음수 = VAT 포함 기준으로는 초과). 기준선 없으면 null. */
  /**
   * ⚠️ 단위를 일부러 섞은 비교다(버그 아님): 기준선(공급가액 기준) − **VAT 포함** 누적. 「네이버가
   * 기준선을 VAT 포함 매출로 판정한다면」이라는 **대안 가설**의 여유를 보조로 보여 준다.
   */
  vatIncludedMargin: number | null;
  /** 진행 막대 — 누적/기준선, 0~1 로 자른다. */
  progressRatio: number;
  /** 보수적 누적(미지정 = 상한). */
  cumulativeSupply: number;
  cumulativeVatIncluded: number;
  /** 미지정을 하한으로 본 누적 — 표시용 범위. */
  cumulativeSupplyLower: number;
  channels: {
    OWN_MALL: TaxableChannelSubtotal;
    BRAND_MALL: TaxableChannelSubtotal;
    SELLER_MALL: TaxableChannelSubtotal;
    UNSPECIFIED: TaxableUnspecifiedSubtotal;
  };
  /** 기준기간 안 미지정 캠페인 수(금액 유무 무관) — 「분류 필요」 경고. */
  unspecifiedCount: number;
  /** 기준기간 안 **끝난** 캠페인 중 금액 미입력 수(전 채널). */
  missingAmountCount: number;
  /** 기준기간 안 진행·예정 캠페인 중 매출 미반영 수(전 채널) — 여유가 더 줄어들 수 있다. */
  pendingCount: number;
  crossingCost: TaxableCrossingCost | null;
};

// ---------------------------------------------------------------------------
// 날짜 — 전부 KST 달력 날짜 문자열로 다룬다(`toKstYmd` SSOT)
// ---------------------------------------------------------------------------

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map((part) => Number(part));
  return { y, m, d };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function halfStartYmd(h: VatHalf): string {
  return `${h.year}-${h.half === 1 ? "01" : "07"}-01`;
}

function halfEndYmd(h: VatHalf): string {
  return `${h.year}-${h.half === 1 ? "06-30" : "12-31"}`;
}

/** KST 날짜가 속한 부가세 반기. */
export function resolveVatHalf(ymd: string): VatHalf {
  const { y, m } = parseYmd(ymd);
  return { year: y, half: m <= 6 ? 1 : 2 };
}

function formatReferenceLabel(halves: VatHalf[]): string {
  if (halves.length === 2 && halves[0].year === halves[1].year) {
    return `${halves[0].year}년 1기+2기`;
  }
  return halves.map((h) => `${h.year}년 ${h.half}기`).join(" + ");
}

/**
 * 다음 갱신일과 그 기준기간 — 오늘(KST 날짜) 기준.
 * 경계: 2/13 까지는 2/14 갱신이 아직 오지 않았고, 2/14 당일부터는 다음이 8/14 다(8월도 같다).
 */
export function resolveNextGradeUpdate(todayYmd: string): {
  nextUpdateYmd: string;
  referencePeriod: TaxableRevenueReferencePeriod;
} {
  const { y, m, d } = parseYmd(todayYmd);
  const md = m * 100 + d;

  let nextUpdateYmd: string;
  let halves: VatHalf[];
  let assumed: boolean;
  if (md >= 214 && md <= 813) {
    nextUpdateYmd = `${y}-08-14`;
    halves = augustUpdateHalves(y);
    assumed = true;
  } else {
    // 8/14 ~ 12/31 → 익년 2/14 · 1/1 ~ 2/13 → 당해 2/14.
    const updateYear = md >= 814 ? y + 1 : y;
    nextUpdateYmd = `${updateYear}-02-14`;
    halves = februaryUpdateHalves(updateYear);
    assumed = false;
  }

  return { nextUpdateYmd, referencePeriod: toReferencePeriod(halves, assumed) };
}

function toReferencePeriod(halves: VatHalf[], assumed: boolean): TaxableRevenueReferencePeriod {
  return {
    halves,
    startYmd: halfStartYmd(halves[0]),
    endYmd: halfEndYmd(halves[halves.length - 1]),
    label: formatReferenceLabel(halves),
    assumed,
  };
}

/** 2/14 갱신의 기준 = 직전 달력연도(1기+2기). */
function februaryUpdateHalves(updateYear: number): VatHalf[] {
  return [
    { year: updateYear - 1, half: 1 },
    { year: updateYear - 1, half: 2 },
  ];
}

/** 8/14 갱신의 기준 = 전년 2기 + 당해 1기(⚠️ 원문 미확인 가정). */
function augustUpdateHalves(updateYear: number): VatHalf[] {
  return [
    { year: updateYear - 1, half: 2 },
    { year: updateYear, half: 1 },
  ];
}

/**
 * **직전** 갱신일과 그 기준기간 — 현재 등급 추정용. 갱신 당일(2/14 · 8/14)은 그날 갱신이 직전이다.
 * - 2/14 ~ 8/13 → 당해 2/14(기준 = 전년 1기+2기)
 * - 8/14 ~ 12/31 → 당해 8/14(기준 = 전년 2기 + 당해 1기, 가정)
 * - 1/1 ~ 2/13 → 전년 8/14(기준 = 재작년 2기 + 전년 1기, 가정)
 */
export function resolvePreviousGradeUpdate(todayYmd: string): {
  updateYmd: string;
  referencePeriod: TaxableRevenueReferencePeriod;
} {
  const { y, m, d } = parseYmd(todayYmd);
  const md = m * 100 + d;
  if (md >= 214 && md <= 813) {
    return { updateYmd: `${y}-02-14`, referencePeriod: toReferencePeriod(februaryUpdateHalves(y), false) };
  }
  const updateYear = md >= 814 ? y : y - 1;
  return { updateYmd: `${updateYear}-08-14`, referencePeriod: toReferencePeriod(augustUpdateHalves(updateYear), true) };
}

/** `ymd` 에서 달력 기준 N개월 전 같은 날(말일 클램프) — 예: 08-31 − 6개월 = 02-28. */
function subtractMonthsYmd(ymd: string, months: number): string {
  const { y, m, d } = parseYmd(ymd);
  const total = y * 12 + (m - 1) - months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${pad2(tm)}-${pad2(Math.min(d, lastDay))}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** KST 날짜 → 일 번호(UTC 자정 기준 경과 일수) — 일수 차 계산 전용. */
function dayNumber(ymd: string): number {
  const { y, m, d } = parseYmd(ymd);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export type CampaignDayRange = { startYmd: string; endYmd: string; totalDays: number };

/**
 * 캠페인의 KST 날짜 구간(양끝 포함). 시작일이 종료일보다 늦은 잘못된 기간은 **종료일 하루**로
 * 본다 — 안분 분모가 0·음수가 되면 매출이 사라지거나 부호가 뒤집힌다.
 */
export function resolveCampaignDayRange(startDate: Date, endDate: Date): CampaignDayRange {
  const endYmd = toKstYmd(endDate);
  const rawStartYmd = toKstYmd(startDate);
  const startYmd = rawStartYmd > endYmd ? endYmd : rawStartYmd;
  return { startYmd, endYmd, totalDays: dayNumber(endYmd) - dayNumber(startYmd) + 1 };
}

/** 구간이 [fromYmd, toYmd](양끝 포함)와 겹치는 일수. */
export function countOverlapDays(range: CampaignDayRange, fromYmd: string, toYmd: string): number {
  const from = Math.max(dayNumber(range.startYmd), dayNumber(fromYmd));
  const to = Math.min(dayNumber(range.endYmd), dayNumber(toYmd));
  return Math.max(0, to - from + 1);
}

/** 일수 안분 — 캠페인 매출 × (겹친 일수 / 전체 일수), 원 단위 반올림. */
export function prorateByDays(amount: number, overlapDays: number, range: CampaignDayRange): number {
  return Math.round((amount * overlapDays) / range.totalDays);
}

function addDaysYmd(ymd: string, days: number): string {
  return new Date((dayNumber(ymd) + days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 비용 표본 창 — `(오늘 − 6개월, 오늘]`(KST 날짜). 예: 오늘 09-29 → 03-30 ~ 09-29.
 * 아직 안 끝난(종료일이 미래인) 캠페인은 들어가지 않는다.
 */
export function resolveCrossingCostWindow(todayYmd: string): { afterYmd: string; toYmd: string } {
  return { afterYmd: subtractMonthsYmd(todayYmd, CROSSING_COST_LOOKBACK_MONTHS), toYmd: todayYmd };
}

/**
 * 로더의 DB 프리필터 하한 — 직전 갱신 기준기간 첫날 · 다음 갱신 기준기간 첫날 · 비용 창 중 가장
 * 이른 날의 **KST 자정** 시각.
 * 종료일의 KST 날짜가 그 날 이상인 캠페인은 전부 이 시각 이상이므로 정밀 판정은 순수 함수가
 * 그대로 한다(프리필터는 행 수만 줄인다).
 */
export function resolveTaxableRevenueQueryFloor(now: Date): Date {
  const todayYmd = toKstYmd(now);
  const floorYmd = [
    resolvePreviousGradeUpdate(todayYmd).referencePeriod.startYmd,
    resolveNextGradeUpdate(todayYmd).referencePeriod.startYmd,
    resolveCrossingCostWindow(todayYmd).afterYmd,
  ].sort()[0];
  return new Date(`${floorYmd}T00:00:00+09:00`);
}

// ---------------------------------------------------------------------------
// 등급
// ---------------------------------------------------------------------------

function toGradeView(grade: NaverSellerGrade): TaxableGradeView {
  return {
    key: grade.key,
    label: grade.label,
    upperSupply: grade.upperSupply,
    feeRateMilliPercent: grade.feeRateMilliPercent,
  };
}

/** 공급가액이 속한 등급의 인덱스 — 상한 「이하」가 그 등급이다. */
export function resolveNaverSellerGradeIndex(supply: number): number {
  const index = NAVER_SELLER_GRADES.findIndex(
    (grade) => grade.upperSupply !== null && supply <= grade.upperSupply,
  );
  return index === -1 ? NAVER_SELLER_GRADES.length - 1 : index;
}

/** 반년 추가 수수료 — 매출 × 요율 차. 요율 단위가 0.001%p 라 100,000 으로 나눈다. */
export function computeFeeIncrease(sales: number, fromMilliPercent: number, toMilliPercent: number): number {
  return Math.round((sales * (toMilliPercent - fromMilliPercent)) / 100_000);
}

// ---------------------------------------------------------------------------
// 캠페인 → 과세 매출
// ---------------------------------------------------------------------------

/**
 * 캠페인의 트래커 채널. ⛔ 미지정은 `resolveTaxFilingChannelGroup` **이전에** 가른다
 * (그 함수는 미지정을 셀러몰로 떨어뜨린다 — 모듈 헤더).
 */
export function resolveTaxableChannelGroup(salesChannel: string | null | undefined): TaxableChannelGroup {
  if (salesChannel == null || salesChannel === "" || salesChannel === "UNSPECIFIED") return "UNSPECIFIED";
  return resolveTaxFilingChannelGroup(salesChannel);
}

type CampaignTaxableAmount =
  | { kind: "AMOUNT"; vatIncluded: number }
  | { kind: "RANGE"; lowerVatIncluded: number; upperVatIncluded: number }
  | { kind: "MISSING" };

/** 캠페인 1건의 과세 매출(VAT 포함). 모르면 `MISSING` — 0 으로 접지 않는다. */
export function computeCampaignTaxableAmount(
  group: TaxableChannelGroup,
  campaign: InvoiceBaseAmountInput,
): CampaignTaxableAmount {
  if (group === "OWN_MALL") {
    return campaign.actualSales == null
      ? { kind: "MISSING" }
      : { kind: "AMOUNT", vatIncluded: Number(campaign.actualSales) };
  }
  if (group === "BRAND_MALL" || group === "SELLER_MALL") {
    const basis = group === "BRAND_MALL" ? "SETTLEMENT_SALES" : "SALES_MINUS_COMMISSION";
    const { baseAmount, blockingReasons } = computeBaseAmountForBasis(basis, campaign);
    return blockingReasons.length > 0 ? { kind: "MISSING" } : { kind: "AMOUNT", vatIncluded: baseAmount };
  }
  // 미지정 — 상한(actualSales)이 없으면 보수적 판정 자체가 불가하므로 미입력이다.
  if (campaign.actualSales == null) return { kind: "MISSING" };
  const upperVatIncluded = Number(campaign.actualSales);
  const brand = computeBaseAmountForBasis("SETTLEMENT_SALES", campaign);
  // 하한은 표시용 — 브랜드몰 산식이 결번이면 0(유효한 하한)으로 두고, 상한을 넘지 않게 자른다.
  const lowerRaw = brand.blockingReasons.length > 0 ? 0 : brand.baseAmount;
  return { kind: "RANGE", lowerVatIncluded: Math.min(lowerRaw, upperVatIncluded), upperVatIncluded };
}

function isExcludedStatus(status: string): boolean {
  return (TAXABLE_REVENUE_EXCLUDED_STATUSES as readonly string[]).includes(status);
}

type ChannelSubtotals = TaxableRevenueTracker["channels"];

type Accumulated = {
  channels: ChannelSubtotals;
  unspecifiedCount: number;
  naverOwnMallSales: number;
  naverOwnMallMissingCount: number;
};

function addToSubtotal(
  subtotal: TaxableChannelSubtotal,
  amount: CampaignTaxableAmount,
  isPending: boolean,
): TaxableChannelSubtotal {
  if (amount.kind === "MISSING") {
    return isPending
      ? { ...subtotal, pendingCount: subtotal.pendingCount + 1 }
      : { ...subtotal, missingCount: subtotal.missingCount + 1 };
  }
  const vatIncluded = amount.kind === "AMOUNT" ? amount.vatIncluded : amount.upperVatIncluded;
  return { ...subtotal, count: subtotal.count + 1, vatIncluded: subtotal.vatIncluded + vatIncluded };
}

/**
 * 넘었을 때 비용 표본 — 네이버페이 결제분(네이버 자사몰)만, 창 `(after, to]` 안 일수로 안분한다.
 * 금액을 모르는 건은 **끝난** 캠페인만 미입력으로 센다(진행 중은 아직 매출이 없는 것이다).
 */
function addCostSample(
  acc: Accumulated,
  campaign: TaxableRevenueCampaignInput,
  range: CampaignDayRange,
  costWindow: { afterYmd: string; toYmd: string },
  isPending: boolean,
): Accumulated {
  if (campaign.salesChannel !== "OWN_MALL_NAVER") return acc;
  const days = countOverlapDays(range, addDaysYmd(costWindow.afterYmd, 1), costWindow.toYmd);
  if (days === 0) return acc;
  if (campaign.actualSales == null) {
    return isPending ? acc : { ...acc, naverOwnMallMissingCount: acc.naverOwnMallMissingCount + 1 };
  }
  return { ...acc, naverOwnMallSales: acc.naverOwnMallSales + prorateByDays(Number(campaign.actualSales), days, range) };
}

/**
 * 기준기간에 귀속되는 이 캠페인의 과세 매출 — 기준기간과 무관하면 null.
 * 자사몰은 일수 안분, 나머지는 종료일 귀속(모듈 헤더 「귀속 기간」).
 */
function resolvePeriodAmount(
  group: TaxableChannelGroup,
  campaign: TaxableRevenueCampaignInput,
  range: CampaignDayRange,
  referencePeriod: TaxableRevenueReferencePeriod,
): CampaignTaxableAmount | null {
  if (group === "OWN_MALL") {
    const days = countOverlapDays(range, referencePeriod.startYmd, referencePeriod.endYmd);
    if (days === 0) return null;
    const amount = computeCampaignTaxableAmount(group, campaign);
    return amount.kind === "AMOUNT"
      ? { kind: "AMOUNT", vatIncluded: prorateByDays(amount.vatIncluded, days, range) }
      : amount;
  }
  if (range.endYmd < referencePeriod.startYmd || range.endYmd > referencePeriod.endYmd) return null;
  return computeCampaignTaxableAmount(group, campaign);
}

/** 캠페인 목록을 채널 소계(VAT 포함)와 비용 표본으로 접는다. 공급가액 변환은 아직 하지 않는다. */
function accumulateCampaigns(
  campaigns: readonly TaxableRevenueCampaignInput[],
  referencePeriod: TaxableRevenueReferencePeriod,
  costWindow: { afterYmd: string; toYmd: string },
  asOfYmd: string,
): Accumulated {
  const empty: TaxableChannelSubtotal = { count: 0, missingCount: 0, pendingCount: 0, vatIncluded: 0, supply: 0 };
  const initial: Accumulated = {
    channels: {
      OWN_MALL: empty,
      BRAND_MALL: empty,
      SELLER_MALL: empty,
      UNSPECIFIED: { ...empty, lowerVatIncluded: 0, lowerSupply: 0 },
    },
    unspecifiedCount: 0,
    naverOwnMallSales: 0,
    naverOwnMallMissingCount: 0,
  };

  return campaigns.reduce<Accumulated>((acc, campaign) => {
    if (isExcludedStatus(campaign.status)) return acc;
    const range = resolveCampaignDayRange(campaign.startDate, campaign.endDate);
    const isPending = range.endYmd > asOfYmd;
    const next = addCostSample(acc, campaign, range, costWindow, isPending);

    const group = resolveTaxableChannelGroup(campaign.salesChannel);
    const amount = resolvePeriodAmount(group, campaign, range, referencePeriod);
    if (amount === null) return next;
    if (group !== "UNSPECIFIED") {
      return {
        ...next,
        channels: { ...next.channels, [group]: addToSubtotal(next.channels[group], amount, isPending) },
      };
    }
    const unspecified = next.channels.UNSPECIFIED;
    return {
      ...next,
      unspecifiedCount: next.unspecifiedCount + 1,
      channels: {
        ...next.channels,
        UNSPECIFIED: {
          ...unspecified,
          ...addToSubtotal(unspecified, amount, isPending),
          lowerVatIncluded:
            unspecified.lowerVatIncluded + (amount.kind === "RANGE" ? amount.lowerVatIncluded : 0),
        },
      },
    };
  }, initial);
}

/** 채널 소계에 공급가액을 채운다(소계마다 표시용 — 누적 합계는 따로 한 번만 변환). */
function withSupply(channels: ChannelSubtotals): ChannelSubtotals {
  const supplyOf = (vatIncluded: number) => splitVatIncluded(vatIncluded).supplyAmount;
  return {
    OWN_MALL: { ...channels.OWN_MALL, supply: supplyOf(channels.OWN_MALL.vatIncluded) },
    BRAND_MALL: { ...channels.BRAND_MALL, supply: supplyOf(channels.BRAND_MALL.vatIncluded) },
    SELLER_MALL: { ...channels.SELLER_MALL, supply: supplyOf(channels.SELLER_MALL.vatIncluded) },
    UNSPECIFIED: {
      ...channels.UNSPECIFIED,
      supply: supplyOf(channels.UNSPECIFIED.vatIncluded),
      lowerSupply: supplyOf(channels.UNSPECIFIED.lowerVatIncluded),
    },
  };
}

type ThresholdState = Pick<
  TaxableRevenueTracker,
  "status" | "thresholdSupply" | "headroomSupply" | "overSupply" | "nextThresholdHeadroomSupply"
>;

/**
 * 기준선 판정. 누적이 속한 등급이 현재 등급보다 위면 OVER — 넘은 선은 **현재 등급**의 상한이다.
 * 아니면 누적이 속한 등급의 상한까지의 여유이고, 그 여유가 기준선의 10% 이하면 NEAR.
 */
function resolveThresholdState(
  cumulativeSupply: number,
  currentGrade: NaverSellerGrade,
  estimatedGrade: NaverSellerGrade,
  isOver: boolean,
): ThresholdState {
  if (isOver) {
    // 현재 등급이 일반(상한 없음)이면 넘을 수 없으므로 여기서 상한은 항상 있다.
    const thresholdSupply = currentGrade.upperSupply;
    return {
      status: "OVER",
      thresholdSupply,
      headroomSupply: null,
      overSupply: thresholdSupply === null ? null : cumulativeSupply - thresholdSupply,
      nextThresholdHeadroomSupply:
        estimatedGrade.upperSupply === null ? null : estimatedGrade.upperSupply - cumulativeSupply,
    };
  }
  const thresholdSupply = estimatedGrade.upperSupply;
  const headroomSupply = thresholdSupply === null ? null : thresholdSupply - cumulativeSupply;
  const isNear =
    headroomSupply !== null && thresholdSupply !== null && headroomSupply <= thresholdSupply * NEAR_THRESHOLD_RATIO;
  return {
    status: isNear ? "NEAR" : "WITHIN",
    thresholdSupply,
    headroomSupply,
    overSupply: null,
    nextThresholdHeadroomSupply: null,
  };
}

/**
 * 넘었을 때 비용. 아직 안 넘었으면 「추정 등급 → 그 위 등급」, 이미 넘었으면 「현재 등급 →
 * 추정 등급」의 요율 차를 네이버 자사몰 최근 6개월 매출에 곱한다. 위 등급이 없으면(일반) null.
 */
function resolveCrossingCost(
  acc: Accumulated,
  currentIndex: number,
  estimatedIndex: number,
): TaxableCrossingCost | null {
  const isOver = estimatedIndex > currentIndex;
  const from = NAVER_SELLER_GRADES[isOver ? currentIndex : estimatedIndex];
  const to: NaverSellerGrade | undefined = NAVER_SELLER_GRADES[isOver ? estimatedIndex : estimatedIndex + 1];
  if (to === undefined) return null;
  return {
    kind: isOver ? "ALREADY_OVER" : "IF_CROSSED",
    from: toGradeView(from),
    to: toGradeView(to),
    naverOwnMallSales: acc.naverOwnMallSales,
    naverOwnMallMissingCount: acc.naverOwnMallMissingCount,
    amount: computeFeeIncrease(acc.naverOwnMallSales, from.feeRateMilliPercent, to.feeRateMilliPercent),
  };
}

/** 채널 소계 → 누적(보수적 · 하한). 공급가액은 합계에 **한 번만** 변환한다(소계 반올림 합은 몇 원 어긋난다). */
function sumCumulative(channels: ChannelSubtotals): {
  cumulativeVatIncluded: number;
  cumulativeSupply: number;
  cumulativeSupplyLower: number;
} {
  const knownVatIncluded =
    channels.OWN_MALL.vatIncluded + channels.BRAND_MALL.vatIncluded + channels.SELLER_MALL.vatIncluded;
  const cumulativeVatIncluded = knownVatIncluded + channels.UNSPECIFIED.vatIncluded;
  return {
    cumulativeVatIncluded,
    cumulativeSupply: splitVatIncluded(cumulativeVatIncluded).supplyAmount,
    cumulativeSupplyLower: splitVatIncluded(knownVatIncluded + channels.UNSPECIFIED.lowerVatIncluded).supplyAmount,
  };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

export function buildTaxableRevenueTracker(
  campaigns: readonly TaxableRevenueCampaignInput[],
  now: Date,
): TaxableRevenueTracker {
  const asOfYmd = toKstYmd(now);
  const costWindow = resolveCrossingCostWindow(asOfYmd);
  const { nextUpdateYmd, referencePeriod } = resolveNextGradeUpdate(asOfYmd);
  const acc = accumulateCampaigns(campaigns, referencePeriod, costWindow, asOfYmd);
  const channels = withSupply(acc.channels);
  const { cumulativeVatIncluded, cumulativeSupply, cumulativeSupplyLower } = sumCumulative(channels);

  // 현재 등급(CRM 추정) — 직전 갱신 기준기간을 **같은 누적 규칙**(자사몰 안분 · 미지정 상한)으로 센다.
  const previousUpdate = resolvePreviousGradeUpdate(asOfYmd);
  const previousCumulativeSupply = sumCumulative(
    accumulateCampaigns(campaigns, previousUpdate.referencePeriod, costWindow, asOfYmd).channels,
  ).cumulativeSupply;
  const currentIndex = resolveNaverSellerGradeIndex(previousCumulativeSupply);
  const estimatedIndex = resolveNaverSellerGradeIndex(cumulativeSupply);
  const currentGrade = NAVER_SELLER_GRADES[currentIndex];
  const estimatedGrade = NAVER_SELLER_GRADES[estimatedIndex];
  const threshold = resolveThresholdState(cumulativeSupply, currentGrade, estimatedGrade, estimatedIndex > currentIndex);
  const { thresholdSupply } = threshold;

  return {
    asOfYmd,
    nextUpdateYmd,
    referencePeriod,
    currentGrade: toGradeView(currentGrade),
    currentGradeEstimated: true,
    previousGradeUpdate: {
      updateYmd: previousUpdate.updateYmd,
      referencePeriod: previousUpdate.referencePeriod,
      cumulativeSupply: previousCumulativeSupply,
    },
    estimatedGrade: toGradeView(estimatedGrade),
    ...threshold,
    vatIncludedMargin: thresholdSupply === null ? null : thresholdSupply - cumulativeVatIncluded,
    progressRatio:
      thresholdSupply === null || thresholdSupply <= 0
        ? 1
        : Math.min(1, Math.max(0, cumulativeSupply / thresholdSupply)),
    cumulativeSupply,
    cumulativeVatIncluded,
    cumulativeSupplyLower,
    channels,
    unspecifiedCount: acc.unspecifiedCount,
    missingAmountCount:
      channels.OWN_MALL.missingCount +
      channels.BRAND_MALL.missingCount +
      channels.SELLER_MALL.missingCount +
      channels.UNSPECIFIED.missingCount,
    pendingCount:
      channels.OWN_MALL.pendingCount +
      channels.BRAND_MALL.pendingCount +
      channels.SELLER_MALL.pendingCount +
      channels.UNSPECIFIED.pendingCount,
    crossingCost: resolveCrossingCost(acc, currentIndex, estimatedIndex),
  };
}
