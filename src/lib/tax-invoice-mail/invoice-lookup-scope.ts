/**
 * 계산서 메일 **자동 조회 대상·기간** SSOT (오너 확정 2026-10-21, client-safe 순수).
 *
 * 계산서는 판매가 끝난 뒤 정산을 거쳐 발행된다. 그래서 자동 조회는
 *   ① 오늘 정산 단계(`SETTLEMENT_STAGE_STATUSES`)에 있고
 *   ② 오늘이 판매 종료일 +`INVOICE_LOOKUP_START_DAYS_AFTER_END`(10일) ~ +`INVOICE_LOOKUP_DAYS_AFTER_END`(60일) 사이인
 * 캠페인만 대상으로 한다. 계산서 확인이 끝났는지(달별 칸이 다 찼는지 · 날짜 칸이 비었는지)는
 * 표면마다 판정 축이 달라 호출부가 덧붙인다 — 이 모듈은 상태·날짜 두 축만 소유한다.
 *
 * 메일 조회 창(오너 확정 2026-10-21): **자동 조회는 판매 종료일 +10일 ~ 오늘**(종료 직후 정산 기간을 지나
 * 발행된다는 업무 기준), **「조회」 버튼의 수동 조회는 판매 종료일 +1일 ~ 오늘**. 종료 후 10일 안에 발행된
 * 계산서 메일(운영 기록상 브랜드몰에 있었다)은 자동으로는 못 찾고 수동 조회가 잡는다.
 * ⛔ 2026-10-21 첫 판의 「판매 시작일부터」는 같은 날 이 기준으로 **SUPERSEDED**.
 * 창의 끝은 따로 두지 않는다: 대상이면 오늘 ≤ 종료일+60 이므로 「오늘까지」가 곧 그 끝이다.
 *
 * **월정산 거래처 캠페인은 예외(오너 확정 2026-10-27, T-270):** 달별 계산서가 판매 중·종료 직후에 발행되므로
 *   ① 판매중·판매마감·정산 단계(`MONTHLY_INVOICE_LOOKUP_STATUSES`)이고 ② 오늘이 판매 **시작일** ~ 종료일 +60일
 * 사이면 대상이고, 메일도 판매 시작일부터 읽는다(자동·수동 모두). 종료 +10일 규칙대로면 판매 중·종료 직후에 오는 달별
 * 계산서를 자동으로 못 찾는다.
 *
 * ⛔ 종전 규칙 「오늘부터 90일 전」(sinceDays=90)은 **SUPERSEDED** — 판매 종료일과 무관해
 * 오래된 캠페인은 「조회불가」, 끝난 캠페인은 화면을 열 때마다 메일함 전체를 다시 훑었다.
 * ⚠️ 세무 보드의 기간 선택 조회는 캠페인 하나에 묶이지 않은 조회라 이 규칙의 대상이 아니다.
 */
import { SETTLEMENT_STAGE_STATUSES } from "../settlement-stage";

/** 조회를 누가 시작했나 — 칸이 열릴 때·매일 작업(auto) 또는 오너의 「조회」 버튼(manual). */
export type InvoiceLookupMode = "auto" | "manual";

/** 판매 종료일 뒤 메일 조회를 시작하는 일수(오너 확정 2026-10-21). */
export const INVOICE_LOOKUP_START_DAYS_AFTER_END: Record<InvoiceLookupMode, number> = { auto: 10, manual: 1 };

/** 판매 종료일 뒤로 자동 조회를 이어 가는 일수(오너 확정 2026-10-21). */
export const INVOICE_LOOKUP_DAYS_AFTER_END = 60;

/**
 * 월정산 거래처 캠페인의 자동 조회 상태 — 판매 중부터(오너 확정 2026-10-27, T-270). 세팅대기는 판매 전이라 계산서가
 * 없고, 정산완료·드랍은 볼 것이 없다.
 */
export const MONTHLY_INVOICE_LOOKUP_STATUSES = ["ACTIVE", "CLOSED", ...SETTLEMENT_STAGE_STATUSES] as const;

/** 조회 창을 정하는 캠페인 사실 — 날짜는 KST `YYYY-MM-DD`. */
export interface InvoiceLookupWindow {
  startYmd: string;
  endYmd: string;
  /** 거래처가 월정산(`Partner.monthlySettlement`)인가 */
  monthlySettlement: boolean;
}

export interface InvoiceLookupCampaign extends InvoiceLookupWindow {
  status: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` 에 일수를 더한다(달력 날짜 산술 — 시간대와 무관). */
export function addDaysToYmd(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 메일 조회 시작일 = 판매 종료일 + 10일(자동) · + 1일(수동). */
export function invoiceLookupFirstYmd(endYmd: string, mode: InvoiceLookupMode): string {
  return addDaysToYmd(endYmd, INVOICE_LOOKUP_START_DAYS_AFTER_END[mode]);
}

/** 자동 조회 마지막 날 = 판매 종료일 + 60일. */
export function invoiceLookupLastYmd(endYmd: string): string {
  return addDaysToYmd(endYmd, INVOICE_LOOKUP_DAYS_AFTER_END);
}

/** 이 캠페인의 메일 조회 시작일 — 월정산은 판매 시작일(자동·수동 같음), 그 밖은 종료 +10일(자동) · +1일(수동). */
export function invoiceLookupWindowStartYmd(campaign: InvoiceLookupWindow, mode: InvoiceLookupMode): string {
  return campaign.monthlySettlement ? campaign.startYmd : invoiceLookupFirstYmd(campaign.endYmd, mode);
}

/** 오늘(KST `YYYY-MM-DD`) 이 캠페인이 계산서 자동 조회 대상인가 — 상태·날짜 두 축. */
export function isInvoiceLookupTarget(campaign: InvoiceLookupCampaign, todayYmd: string): boolean {
  const statuses: readonly string[] = campaign.monthlySettlement ? MONTHLY_INVOICE_LOOKUP_STATUSES : SETTLEMENT_STAGE_STATUSES;
  if (!statuses.includes(campaign.status)) return false;
  // 조회 시작일 전에는 조회할 기간이 아직 없다.
  return invoiceLookupWindowStartYmd(campaign, "auto") <= todayYmd && todayYmd <= invoiceLookupLastYmd(campaign.endYmd);
}

/**
 * 메일 조회 창의 일수 — 캠페인들의 조회 시작일(`invoiceLookupWindowStartYmd`) 중 가장 이른 날부터 오늘까지(양끝 포함).
 * 메일 스캔은 「오늘 − N일」 이후를 읽으므로 하루를 더해 시작일 당일이 빠지지 않게 한다. 시작일이 아직 오지
 * 않았으면 1(오늘 하루 — 수동 「조회」에서만 생긴다). 캠페인이 하나도 없으면 null(조회할 대상이 없다).
 */
export function invoiceLookupSinceDays(
  windows: readonly InvoiceLookupWindow[],
  todayYmd: string,
  mode: InvoiceLookupMode,
): number | null {
  if (windows.length === 0) return null;
  const earliest = windows.map((window) => invoiceLookupWindowStartYmd(window, mode)).sort()[0];
  const days = Math.round((ymdToUtcMs(todayYmd) - ymdToUtcMs(earliest)) / DAY_MS) + 1;
  return Math.max(1, days);
}

/**
 * 오늘 메일함을 열어야 하는가 — 대상 중 **발행 확인이 남은 것**이 하나라도 있을 때만(오너 확정 2026-10-21).
 * 날짜 칸이 빈 발행 건(`alreadyMarkedAt === null`)이거나 빈 발행 달이 있는 월정산 단위. 대상 판정은 호출부가 넘긴다.
 */
export function hasOpenInvoiceLookupTarget(input: {
  issuances: ReadonlyArray<{ alreadyMarkedAt: string | null; campaignIds: readonly string[] }>;
  monthlyUnits: ReadonlyArray<{ unitKey: string; direction: string; openMonths: readonly unknown[] }>;
  isTargetCampaign: (campaignId: string) => boolean;
  isTargetUnit: (unitKey: string) => boolean;
}): boolean {
  return (
    input.issuances.some((item) => item.alreadyMarkedAt === null && item.campaignIds.some(input.isTargetCampaign)) ||
    input.monthlyUnits.some(
      (unit) => unit.direction === "ISSUE" && unit.openMonths.length > 0 && input.isTargetUnit(unit.unitKey),
    )
  );
}
