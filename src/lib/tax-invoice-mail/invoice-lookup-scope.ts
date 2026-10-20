/**
 * 계산서 메일 **자동 조회 대상·기간** SSOT (오너 확정 2026-10-21, client-safe 순수).
 *
 * 계산서는 판매가 끝난 뒤 정산을 거쳐 발행된다. 그래서 자동 조회는
 *   ① 오늘 정산 단계(`SETTLEMENT_STAGE_STATUSES`)에 있고
 *   ② 판매 종료일 + `INVOICE_LOOKUP_DAYS_AFTER_END`(60일)을 넘기지 않은
 * 캠페인만 대상으로 한다. 계산서 확인이 끝났는지(달별 칸이 다 찼는지 · 날짜 칸이 비었는지)는
 * 표면마다 판정 축이 달라 호출부가 덧붙인다 — 이 모듈은 상태·날짜 두 축만 소유한다.
 *
 * 메일 조회 창의 시작은 **판매 시작일**이다(종료일이 아니다). 월정산은 판매가 달을 넘기면 앞 달
 * 계산서가 판매 종료 전에 나온다 — 운영 기록에서 종료일보다 앞선 작성일이 실제로 있었다.
 * 창의 끝은 따로 두지 않는다: 대상이면 오늘 ≤ 종료일+60 이므로 「오늘까지」가 곧 그 끝이다.
 *
 * ⛔ 종전 규칙 「오늘부터 90일 전」(sinceDays=90)은 **SUPERSEDED** — 판매 종료일과 무관해
 * 오래된 캠페인은 「조회불가」, 끝난 캠페인은 화면을 열 때마다 메일함 전체를 다시 훑었다.
 * ⚠️ 세무 보드의 기간 선택 조회는 캠페인 하나에 묶이지 않은 조회라 이 규칙의 대상이 아니다.
 */
import { SETTLEMENT_STAGE_STATUSES } from "../settlement-stage";

/** 판매 종료일 뒤로 자동 조회를 이어 가는 일수(오너 확정 2026-10-21). */
export const INVOICE_LOOKUP_DAYS_AFTER_END = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`);
}

/** `YYYY-MM-DD` 에 일수를 더한다(달력 날짜 산술 — 시간대와 무관). */
export function addDaysToYmd(ymd: string, days: number): string {
  return new Date(ymdToUtcMs(ymd) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 자동 조회 마지막 날 = 판매 종료일 + 60일. */
export function invoiceLookupLastYmd(endYmd: string): string {
  return addDaysToYmd(endYmd, INVOICE_LOOKUP_DAYS_AFTER_END);
}

/** 오늘(KST `YYYY-MM-DD`) 이 캠페인이 계산서 자동 조회 대상인가 — 상태·날짜 두 축. */
export function isInvoiceLookupTarget(
  campaign: { status: string; endYmd: string },
  todayYmd: string,
): boolean {
  if (!(SETTLEMENT_STAGE_STATUSES as readonly string[]).includes(campaign.status)) return false;
  return todayYmd <= invoiceLookupLastYmd(campaign.endYmd);
}

/**
 * 메일 조회 창의 일수 — 가장 이른 판매 시작일부터 오늘까지(양끝 포함).
 * 메일 스캔은 「오늘 − N일」 이후를 읽으므로 하루를 더해 시작일 당일이 빠지지 않게 한다.
 * 시작일이 하나도 없으면 null(조회할 대상이 없다).
 */
export function invoiceLookupSinceDays(startYmds: readonly string[], todayYmd: string): number | null {
  if (startYmds.length === 0) return null;
  const earliest = [...startYmds].sort()[0];
  const days = Math.round((ymdToUtcMs(todayYmd) - ymdToUtcMs(earliest)) / DAY_MS) + 1;
  return Math.max(1, days);
}
