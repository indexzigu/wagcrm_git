// 판매기간(집계 컷오프) 해석의 단일 진실(SSOT) — 순수 함수만(프리즈마·fs 없음)이라 라이브 집계
// (campaigns-handler)·마감 스냅샷(closed-campaign-cache)·재동기화 판정(mapping-service)이 같은
// 규칙을 공유한다. 종료 컷오프가 지점마다 어긋나면 매출/수량이 달라지는 실사고가 난다.
//
// 핵심 규칙(오너 지시 2026-07-14):
//  - 판매기간 '종료'는 반드시 마감 당일 KST 끝(23:59:59.999+09:00)까지 포함한다. 날짜만 저장된
//    종료값(UTC 자정 또는 KST 자정)을 그대로 컷오프로 쓰면 마감 당일 오전/오후 주문이 통째로
//    누락되거나(마감 당일 컷오프 실사고: UTC 자정=KST 09:00) 다음날로 새어나간다.
//  - 스토어 API가 준 '정밀 종료시각'(시:분이 있는 값)은 그 시각을 그대로 기준으로 삼는다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 날짜 경계(UTC 자정 또는 KST 자정)인지 — 즉 '날짜만 저장된 종료값'인지 판정한다.
 * 스토어/판매캠페인 endDate는 UTC 자정(날짜 피커) 또는 KST 자정(스토어 API)으로 저장될 수 있는데,
 * 둘 다 "그 날 하루"를 뜻하므로 KST 종일로 보정해야 한다. 시:분이 있는 정밀 종료시각만 그대로 존중한다.
 */
export function isDayBoundaryMs(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const utcMod = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  const kstMod = (((ms + KST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
  return utcMod === 0 || kstMod === 0;
}

/** ms가 속한 KST 날짜의 시작(00:00:00.000+09:00) ms. */
export function startOfKstDayMs(ms: number): number {
  const d = new Date(ms + KST_OFFSET_MS);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - KST_OFFSET_MS;
}

/** ms가 속한 KST 날짜의 끝(23:59:59.999+09:00) ms. */
export function endOfKstDayMs(ms: number): number {
  const d = new Date(ms + KST_OFFSET_MS);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime() - KST_OFFSET_MS;
}

/**
 * OrderCampaign에 저장된 판매 종료 시각(ms)을 파싱한다. endDate(DateTime) 우선, 없으면
 * salePeriod 문자열("YYYY.MM.DD ~ YYYY.MM.DD")의 종료일을 KST 자정 기준으로 해석. 없으면 null.
 * (재동기화 판정용 원시값 — 보정은 resolveSaleWindowEndMs가 한다.)
 */
export function parseStoredPeriodEndMs(camp: { endDate?: Date | string | null; salePeriod?: string | null }): number | null {
  if (camp.endDate) {
    const t = new Date(camp.endDate).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const sp = camp.salePeriod;
  if (sp && sp.includes('~')) {
    const end = sp.split('~')[1]?.trim();
    if (end && end !== '계속') {
      const t = new Date(end.replace(/\./g, '-') + 'T23:59:59.999+09:00').getTime();
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * 집계 컷오프용 판매기간 종료(ms). parseStoredPeriodEndMs를 기반으로 하되, 날짜만 저장된 종료값
 * (UTC 자정 또는 KST 자정)은 'KST 그 날 끝(23:59:59.999)'으로 보정한다. 마감 당일 오전 이후 주문이
 * 매출/수량 집계에서 통째로 잘리던 버그(연결 판매캠페인 endDate가 날짜만 저장됨, 마감 당일 컷오프 실사고)
 * 방지. 스토어 API가 준 정밀 종료시각(시:분이 있는 값)은 그대로 존중한다. null=미확정.
 */
export function resolveSaleWindowEndMs(camp: { endDate?: Date | string | null; salePeriod?: string | null }): number | null {
  const raw = parseStoredPeriodEndMs(camp);
  if (raw === null) return null;
  return isDayBoundaryMs(raw) ? endOfKstDayMs(raw) : raw;
}

/**
 * 집계 컷오프용 판매기간 시작(ms). startDate(정밀 존중, 날짜 전용이면 KST 자정 시작) 우선, 없으면
 * salePeriod 시작일 → KST 자정 시작. null=미확정(호출부에서 0=전체 허용으로 처리).
 */
export function resolveSaleWindowStartMs(camp: { startDate?: Date | string | null; salePeriod?: string | null }): number | null {
  if (camp.startDate) {
    const t = new Date(camp.startDate).getTime();
    if (!Number.isNaN(t)) return isDayBoundaryMs(t) ? startOfKstDayMs(t) : t;
  }
  const sp = camp.salePeriod;
  if (sp && sp.includes('~')) {
    const start = sp.split('~')[0]?.trim();
    if (start && start !== '기간 미정' && start !== '미등록') {
      const t = new Date(start.replace(/\./g, '-') + 'T00:00:00.000+09:00').getTime();
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * salePeriod 문자열("YYYY.MM.DD ~ YYYY.MM.DD" | "… ~ 계속")만으로 경계를 파싱한다 — 저장된
 * startDate/endDate는 보지 않는다. 판매기간 정본(startDate/endDate)을 문자열 편집으로부터 영속할 때 쓴다.
 * hasOpenEnd=true면 종료 미정('계속')이라 endDate를 비워야 한다(옛 종료값을 남기면 컷오프가 조기 절단).
 */
export function parseSalePeriodBounds(sp: string | null | undefined): {
  startMs: number | null;
  endMs: number | null;
  hasOpenEnd: boolean;
} {
  const empty = { startMs: null, endMs: null, hasOpenEnd: false };
  if (!sp || !sp.includes('~')) return empty;

  const [rawStart, rawEnd] = sp.split('~').map((s) => s.trim());
  if (!rawStart || rawStart === '기간 미정' || rawStart === '미등록') return empty;

  const startMs = new Date(rawStart.replace(/\./g, '-') + 'T00:00:00.000+09:00').getTime();
  if (Number.isNaN(startMs)) return empty;

  if (rawEnd === '계속') return { startMs, endMs: null, hasOpenEnd: true };
  if (!rawEnd) return { startMs, endMs: null, hasOpenEnd: false };

  const endMs = new Date(rawEnd.replace(/\./g, '-') + 'T23:59:59.999+09:00').getTime();
  return { startMs, endMs: Number.isNaN(endMs) ? null : endMs, hasOpenEnd: false };
}

/**
 * 집계 창(ms)을 화면 표시용 'YYYY.MM.DD ~ YYYY.MM.DD' 문자열로 만든다(KST 달력일 기준, 서버 TZ 무관).
 * 표시 문자열은 반드시 **컷오프와 같은 값**에서 파생돼야 한다 — 스토어 관측값(salePeriod)을 그대로
 * 띄우면 표시와 집계가 갈라져 "화면 기간은 맞는데 매출만 다르다"는 실사고(#170)가 재발한다.
 * start가 유한하지 않으면(창 미확정) null — 호출부가 폴백을 정한다.
 */
export function formatKstPeriodLabel(startMs: number | null, endMs: number | null): string | null {
  if (startMs === null || !Number.isFinite(startMs)) return null;
  const fmt = (ms: number) => {
    const d = new Date(ms + KST_OFFSET_MS);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dt = String(d.getUTCDate()).padStart(2, '0');
    return `${y}.${m}.${dt}`;
  };
  const end = endMs !== null && Number.isFinite(endMs) ? fmt(endMs) : '계속';
  return `${fmt(startMs)} ~ ${end}`;
}

/** 두 시각이 같은 KST 달력일인지. 날짜 단위 편집이 스토어 정밀 시각을 덮어쓰지 않게 하는 게이트. */
export function isSameKstDay(a: Date | string | null | undefined, bMs: number | null): boolean {
  if (!a || bMs === null) return false;
  const am = new Date(a).getTime();
  if (Number.isNaN(am)) return false;
  return startOfKstDayMs(am) === startOfKstDayMs(bMs);
}

/**
 * 연결된 판매캠페인들로부터 이 주문캠페인의 집계 창을 도출한다.
 *
 * 정본 규칙(오너 확정 2026-07-15): **판매기간의 정본은 판매관리(SalesCampaign) 일정**이고,
 * 스토어(네이버) 기간은 관측값일 뿐이다. 스토어는 기간 연장·'종료 후 별도 주문건을 받으려고 임시로
 * 판매를 여는' 운영 때문에 실제 회차 경계와 어긋나는데, 그 값이 판매캠페인으로 흘러들면 정산서·구글
 * 캘린더·재구매 집계까지 오염된다(판매캠페인 기간을 그 전부가 소비한다).
 *
 * min(시작)~max(종료) 합성인 이유: 한 주문캠페인에 딜별 판매캠페인이 4~5개 물리는 게 표준이고(실측),
 * 대부분 기간이 같다. 딜 하나만 짧게 운영해 어긋나는 사례가 실재하지만 주문캠페인은 단일 창만 표현할 수
 * 있다 — 오너 결정은 "합성하되 어긋나면 경고"다(hasPeriodMismatch).
 *
 * 종료값을 여기서 KST 종일로 보정하지 않는다 — 호출부가 endDate로 저장하면 resolveSaleWindowEndMs가
 * 읽는 시점에 보정한다(보정 지점을 한 곳으로 유지).
 */
export function resolveSalesCampaignWindow(
  salesCampaigns: Array<{ startDate?: Date | string | null; endDate?: Date | string | null }> | null | undefined,
): { startMs: number; endMs: number | null; hasPeriodMismatch: boolean } | null {
  const rows = (salesCampaigns ?? [])
    .map((sc) => ({
      start: sc.startDate ? new Date(sc.startDate).getTime() : Number.NaN,
      end: sc.endDate ? new Date(sc.endDate).getTime() : Number.NaN,
    }))
    .filter((r) => !Number.isNaN(r.start));
  if (rows.length === 0) return null;

  const starts = rows.map((r) => r.start);
  const ends = rows.map((r) => r.end).filter((e) => !Number.isNaN(e));

  // 어긋남 판정은 KST 달력일 기준 — 저장 형태(UTC 자정 vs KST 자정)가 섞여도 같은 날이면 같다고 본다.
  const hasPeriodMismatch =
    new Set(starts.map((s) => startOfKstDayMs(s))).size > 1 ||
    new Set(ends.map((e) => startOfKstDayMs(e))).size > 1;

  return {
    startMs: Math.min(...starts),
    endMs: ends.length > 0 ? Math.max(...ends) : null,
    hasPeriodMismatch,
  };
}

/**
 * 이 캠페인이 '네이버 주문 조회창 시작일'에 기여할 시각(ms). null=기여 없음.
 *
 * 실사고(2026-07-15): 조회창 계산이 이 SSOT를 쓰지 않고 `camp.startDate`를 raw로 읽어,
 * startDate가 null인 캠페인은 salePeriod에 시작일이 멀쩡히 있는데도 기여 0이 됐다. 활성 캠페인이
 * 전부 그러면 조회창이 기본값('오늘-7일')으로 떨어져 그 이전 주문은 **조회 자체가 안 되고**, 매출이
 * 조용히 사라진 채 시작일이 매일 하루씩 밀린다. 컷오프(resolveSaleWindowStartMs)는 멀쩡한데 조회창만
 * 틀려서 화면상 판매기간과 매출 시작일이 어긋나는 게 이 버그의 지문이다.
 *
 * **불변식: 조회창은 각 캠페인의 컷오프보다 이르거나 같아야 한다.** 이걸 어기면 컷오프 안쪽 주문이
 * 조회조차 안 돼 위 실사고가 재현된다. 그래서 후보가 둘 다 있으면 이른 쪽(min)을 택한다 —
 * 정상 상태에선 startDate가 판매관리 파생이라 두 값이 같고, 어긋나는 건 동결(정산 락)로 startDate가
 * 옛 창에 멈춰 있거나 아직 동기화가 안 닿은 과도기뿐이다. 그 경우 넓게 잡아 조회한 뒤 컷오프가
 * 걸러내므로 결과는 정확하고 비용만 조금 는다(조회창 상한 MAX_DAYS로 이미 봉인).
 */
export function resolveCampaignQueryStartMs(camp: {
  startDate?: Date | string | null;
  salePeriod?: string | null;
  salesCampaigns?: Array<{ startDate?: Date | string | null; endDate?: Date | string | null }> | null;
}): number | null {
  // 저장된 창(startDate → salePeriod 폴백) — 컷오프가 실제로 읽는 값.
  const storedStart = resolveSaleWindowStartMs(camp);

  // 판매관리 창(정본). 동기화가 아직 안 닿았거나 동결된 캠페인에서도 컷오프를 놓치지 않게 함께 본다.
  const salesWindow = resolveSalesCampaignWindow(camp.salesCampaigns);
  const salesStart =
    salesWindow === null
      ? null
      : isDayBoundaryMs(salesWindow.startMs)
        ? startOfKstDayMs(salesWindow.startMs)
        : salesWindow.startMs;

  if (storedStart !== null && salesStart !== null) return Math.min(storedStart, salesStart);
  return storedStart ?? salesStart ?? null;
}
