/**
 * 월별 정산 줄(T-240) 판정·계산 SSOT — **client-safe 순수 모듈**(Prisma·node 무의존).
 *
 * 무엇인가: 월정산 거래처(`Partner.monthlySettlement`)의 캠페인은 한 회차가 월을 넘기면 브랜드
 * 계산서가 9월분·10월분으로 나뉜다. 캠페인은 **쪼개지 않고**(주문수량·거래액은 셀러 전달 데이터와
 * 연동) 캠페인 안에 월별 줄을 1:N 으로 쌓는다. 셀러 정산은 월로 나누지 않는다(캠페인 단위 그대로).
 * 귀속 기준은 주문일이다(오너 확정 2026-10-08).
 *
 * 쓰기·롤업은 `src/services/monthlySettlementService.ts`, 기존 캠페인 이전(줄 1개 만들기) 매핑은
 * `monthly-settlement-backfill.ts` 가 소유한다. 화면·라우트에서 아래 판정을 다시 쓰지 말 것 —
 * 이 레포가 반복해 온 사고(같은 판정을 표면마다 손으로 재구현해 갈라짐)의 같은 부류가 된다.
 *
 * 설계 정본: docs/private/specs/2026-10-08-monthly-settlement-lines-design.md
 */
import { splitVatIncluded } from "./vat";
import { toKstYmd } from "./date-utils";

/**
 * 월별 체크리스트 4항목 — 명세 순서 그대로. 키는 DB 열 이름이고, 값이 있으면(처리일) 완료다.
 * ⛔ 항목을 늘리거나 줄일 때 `isMonthlyLineComplete` 를 따로 고치지 말 것 — 이 배열에서 파생한다.
 */
export const MONTHLY_CHECKLIST_ITEMS = [
  { key: "salesInvoiceCheckedAt", label: "수수료 계산서 발행" },
  { key: "purchaseInvoiceCheckedAt", label: "공급사 매입 계산서 수취" },
  { key: "paymentScheduleCheckedAt", label: "지급 일정 확정" },
  { key: "paymentCompletedCheckedAt", label: "공급사 대금 지급 완료" },
] as const;

export type MonthlyChecklistKey = (typeof MONTHLY_CHECKLIST_ITEMS)[number]["key"];

/**
 * 정산 완료로 넘어가지 못할 때 오너에게 보이는 문구(라우트 409 · 어시스턴트 결과 공용).
 * 어느 달이 몇 칸 남았는지를 이름으로 말한다 — 「안 된다」만 말하면 오너가 패널을 다시 뒤져야 한다
 * (ss-ux-designer 검토 2026-10-08).
 */
export function buildMonthlyIncompleteMessage(
  lines: readonly (Pick<MonthlySettlementLine, "yearMonth"> & ChecklistFields)[],
): string {
  if (lines.length === 0) {
    return "월별 정산 줄이 없어 정산 완료로 바꿀 수 없습니다. 캠페인 상세의 월별 정산에서 줄을 추가해주세요.";
  }
  const pending = sortMonthlyLines(lines)
    .filter((line) => !isMonthlyLineComplete(line))
    .map(
      (line) =>
        `${formatMonthlyLineLabel(line.yearMonth)}(${countMonthlyChecks(line)}/${MONTHLY_CHECKLIST_ITEMS.length})`,
    );
  return `월별 정산 중 ${pending.join(", ")}이 끝나지 않아 정산 완료로 바꿀 수 없습니다.`;
}

/**
 * 화면·API 가 주고받는 줄 모양 — 금액은 number, 날짜는 KST "YYYY-MM-DD" 문자열.
 * 미입력은 null 이다(⚠️ 0 과 구분한다 — 0 은 「값이 있다」).
 */
export type MonthlySettlementLine = {
  id: string;
  campaignId: string;
  yearMonth: string;
  periodStart: string | null;
  periodEnd: string | null;
  quantity: number | null;
  transactionAmount: number | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  supplyAmount: number | null;
  vat: number | null;
  salesInvoiceIssuedAt: string | null;
  salesInvoiceNo: string | null;
  salesInvoiceItemName: string | null;
  purchaseInvoiceReceivedAt: string | null;
  goodsAmount: number | null;
  paymentAmount: number | null;
  paymentDueDate: string | null;
  paymentPaidAt: string | null;
  salesInvoiceCheckedAt: string | null;
  purchaseInvoiceCheckedAt: string | null;
  paymentScheduleCheckedAt: string | null;
  paymentCompletedCheckedAt: string | null;
  memo: string | null;
};

const YEAR_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidYearMonth(value: string): boolean {
  return YEAR_MONTH_RE.test(value);
}

/** 날짜의 KST 귀속 월("YYYY-MM"). */
export function toKstYearMonth(date: Date): string {
  return toKstYmd(date).slice(0, 7);
}

/** "2026-12" → "2027-01". */
export function nextYearMonth(yearMonth: string): string {
  const match = YEAR_MONTH_RE.exec(yearMonth);
  if (!match) throw new Error(`invalid yearMonth: ${yearMonth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** 그 달의 마지막 날 "YYYY-MM-DD"(달력 계산 — 시간대 무관). */
function lastDayOfMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${yearMonth}-${String(day).padStart(2, "0")}`;
}

/**
 * 캠페인 기간(KST ymd)을 그 달로 자른 귀속 기간. 캠페인이 그 달에 걸치지 않으면 null 들을 준다
 * (다음 달 줄을 미리 만드는 경우 — 기간은 오너가 채운다).
 */
export function clipPeriodToMonth(
  campaignStartYmd: string,
  campaignEndYmd: string,
  yearMonth: string,
): { periodStart: string | null; periodEnd: string | null } {
  const monthStart = `${yearMonth}-01`;
  const monthEnd = lastDayOfMonth(yearMonth);
  const start = campaignStartYmd > monthStart ? campaignStartYmd : monthStart;
  const end = campaignEndYmd < monthEnd ? campaignEndYmd : monthEnd;
  if (start > end) return { periodStart: null, periodEnd: null };
  return { periodStart: start, periodEnd: end };
}

/**
 * 수수료액(VAT 포함) 기본값 = floor(거래액 × 요율 / 100) — 캠페인 영업수익과 **같은 식**
 * (`revenue-calc.computeRevenue` 의 netRevenue). 둘 중 하나라도 없으면 null.
 */
export function computeMonthlyCommission(
  transactionAmount: number | null,
  commissionRate: number | null,
): number | null {
  if (transactionAmount == null || commissionRate == null) return null;
  return Math.floor((transactionAmount * commissionRate) / 100);
}

/** 수수료액 → 공급가액·세액. 분해 식은 `vat.ts` 하나다(여기서 다시 쓰지 않는다). */
export function splitMonthlyCommission(commissionAmount: number | null): {
  supplyAmount: number | null;
  vat: number | null;
} {
  if (commissionAmount == null) return { supplyAmount: null, vat: null };
  const { supplyAmount, taxAmount } = splitVatIncluded(commissionAmount);
  return { supplyAmount, vat: taxAmount };
}

/** 지급액 — 미입력이면 물품대금을 지급액으로 본다(명세 「지급액 = 물품대금」). */
export function resolveMonthlyPaymentAmount(
  line: Pick<MonthlySettlementLine, "paymentAmount" | "goodsAmount">,
): number | null {
  return line.paymentAmount ?? line.goodsAmount ?? null;
}

/** 체크 칸 — 화면은 ymd 문자열, 서버 행은 Date 로 들어온다(둘 다 「값 있음 = 완료」). */
type ChecklistFields = { readonly [K in MonthlyChecklistKey]: string | Date | null };

export function countMonthlyChecks(line: ChecklistFields): number {
  return MONTHLY_CHECKLIST_ITEMS.filter((item) => line[item.key] != null).length;
}

export function isMonthlyLineComplete(line: ChecklistFields): boolean {
  return countMonthlyChecks(line) === MONTHLY_CHECKLIST_ITEMS.length;
}

/**
 * 「정산 완료로 넘어가면 안 되는가」 — 월정산 거래처 캠페인은 줄이 하나 이상 있고 **모든 줄**의
 * 체크리스트가 끝나야 완료다(명세 「정산 완료는 모든 월별 줄의 체크리스트가 완료될 때만 가능」).
 * ⚠️ 줄 0개는 「막음」이다 — 비어 있는 것을 「전부 끝남」으로 읽으면 게이트가 공허하게 통과한다.
 * 월정산이 아닌 거래처는 언제나 false(기존 동작 그대로).
 */
export function isMonthlyCompletionBlocked(input: {
  monthlySettlementEnabled: boolean;
  lines: readonly ChecklistFields[];
}): boolean {
  if (!input.monthlySettlementEnabled) return false;
  if (input.lines.length === 0) return true;
  return !input.lines.every(isMonthlyLineComplete);
}

/**
 * 캠페인 물품대금(수기 물품대금 열) 롤업 = 값이 있는 줄의 물품대금 합. 전부 비었으면 null
 * (물품대금 3-상태의 「미입력 = 공식 추정」을 지킨다 — `goods-cost.ts`).
 */
export function rollupMonthlyGoodsCost(
  lines: readonly Pick<MonthlySettlementLine, "goodsAmount">[],
): number | null {
  const values = lines.map((line) => line.goodsAmount).filter((v): v is number => v != null);
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0);
}

export type MonthlySettlementSummary = {
  transactionTotal: number;
  /** 캠페인 총 거래액(`actualSales`). 미입력이면 null — 그때는 비교하지 않는다. */
  campaignTransactionAmount: number | null;
  /** 월별 합 − 캠페인 총액. 비교할 수 없으면 null. */
  transactionDiff: number | null;
  paymentTotal: number;
  goodsTotal: number;
  completedLines: number;
  lineCount: number;
};

/**
 * 합계 검증 줄의 숫자 — 월별 거래액 합 vs 캠페인 총 거래액, 월별 지급액 합.
 * 미입력 거래액 줄은 합에 0 으로 들어간다(그 결과 차이가 드러나는 것이 의도다 — 입력 누락도
 * 「불일치」로 보여야 한다).
 */
export function summarizeMonthlySettlements(
  lines: readonly MonthlySettlementLine[],
  campaignTransactionAmount: number | null,
): MonthlySettlementSummary {
  const transactionTotal = lines.reduce((sum, line) => sum + (line.transactionAmount ?? 0), 0);
  const paymentTotal = lines.reduce((sum, line) => sum + (resolveMonthlyPaymentAmount(line) ?? 0), 0);
  const goodsTotal = lines.reduce((sum, line) => sum + (line.goodsAmount ?? 0), 0);
  return {
    transactionTotal,
    campaignTransactionAmount,
    transactionDiff:
      campaignTransactionAmount == null ? null : transactionTotal - campaignTransactionAmount,
    paymentTotal,
    goodsTotal,
    completedLines: lines.filter(isMonthlyLineComplete).length,
    lineCount: lines.length,
  };
}

/** 줄 목록 정렬 — 귀속 월 오름차순. */
export function sortMonthlyLines<T extends { yearMonth: string }>(lines: readonly T[]): T[] {
  return [...lines].sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

/**
 * 다음에 추가할 달 — 캠페인 기간(시작월~종료월) 중 줄이 없는 **가장 이른** 달. 다 차 있으면 null.
 * ⚠️ 「마지막 줄의 다음 달」로 정하지 말 것: 기존 캠페인 이전은 종료월에 줄 1개를 만들므로
 * (9/28~10/4 → 10월분), 나눌 달은 그 **앞**(9월분)이다. 귀속 기준이 주문일이라 종료월 뒤의 달은
 * 정의상 없다(기간 후 주문은 판매관리에서 종료일을 늘려 포함한다 — P7).
 */
export function resolveNextMonthToAdd(
  lines: readonly { yearMonth: string }[],
  campaignStartYmd: string,
  campaignEndYmd: string,
): string | null {
  const taken = new Set(lines.map((line) => line.yearMonth));
  const endMonth = campaignEndYmd.slice(0, 7);
  for (let month = campaignStartYmd.slice(0, 7); month <= endMonth; month = nextYearMonth(month)) {
    if (!taken.has(month)) return month;
  }
  return null;
}

/**
 * 주문일 기준 참고값 — 마감 시 저장된 일별 매출(`OrderCampaign.cachedDailyStats`, KST 날짜)을
 * 달별로 더한다. ⚠️ 캠페인 전체(품목 구분 없음)의 주문캠페인 값이라 판매관리 거래액
 * (`actualSales`)과 다를 수 있다 — 자동으로 줄에 쓰지 않고 **참고로만** 보여준다
 * (명세 「주문수량·거래액을 정산에 맞추려고 수정하는 로직 금지」).
 */
export function attributeDailyStatsToMonths(
  daily: readonly { date: string; orders: number; revenue: number }[],
): Record<string, { orders: number; revenue: number }> {
  const byMonth: Record<string, { orders: number; revenue: number }> = {};
  for (const point of daily) {
    const yearMonth = point.date.slice(0, 7);
    if (!isValidYearMonth(yearMonth)) continue;
    const bucket = (byMonth[yearMonth] ??= { orders: 0, revenue: 0 });
    bucket.orders += point.orders;
    bucket.revenue += point.revenue;
  }
  return byMonth;
}

/** "2026-09" → "9월분" — 정산 목록 배지·패널 제목 공용. */
export function formatMonthlyLineLabel(yearMonth: string): string {
  return `${Number(yearMonth.slice(5, 7))}월분`;
}
