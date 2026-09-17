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
  const end = endMs !== null && Number.isFinite(endMs) ? formatKstDateLabel(endMs) : '계속';
  return `${formatKstDateLabel(startMs)} ~ ${end}`;
}

/** 표시용 KST 달력일 한 개(`YYYY.MM.DD`). 기간 라벨과 **같은 포맷터**여야 화면에서 어긋나지 않는다. */
export function formatKstDateLabel(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dt = String(d.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${dt}`;
}

/**
 * ms 가 속한 KST 달력일을 `YYYY-MM-DD` 로. 날짜 단위 API(판매캠페인 PATCH 의 `startDate`·
 * `endDate` 는 `z.string().date()`)에 넘길 값이라 표시용 `formatKstPeriodLabel`(점 구분)과
 * 포맷이 다르다 — 둘을 한 함수로 합치지 말 것(구분자만 바꾸면 소비처가 어느 쪽인지 흐려진다).
 */
export function formatKstYmd(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dt = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dt}`;
}

/**
 * 이 주문캠페인의 **집계 창이 얼었는가** — 딜 하나라도 정산 락이면 참.
 *
 * 창은 주문캠페인당 하나뿐이라 늘리면 이미 정산 중인 딜의 귀속 주문까지 바뀐다. 그래서 회차를
 * 골라내지 않고 캠페인 단위로 얼린다(오너: "정산시작이 들어가면 판매마감도 확정"). 두 소비처가
 * 같은 술어를 써야 한다 — 화면 동결(`campaigns-handler`)과 「눌러서 바꿀 수 있는가」
 * (`resolveStorePeriodDrift`)가 갈리면 **누를 것 없는 배지**가 뜬다.
 */
export function isCampaignPeriodFrozen(
  salesCampaigns: Array<{ status?: string | null }> | null | undefined,
): boolean {
  return (salesCampaigns ?? []).some((sc) => isSalesCampaignLocked(sc.status));
}

/**
 * 스토어가 **판매중**일 때만 그 기간 전체를 신뢰한다.
 *
 * 실측(2026-09-17, 프로덕션 2건): 판매가 끝난 상태(`CLOSE`·`OUTOFSTOCK`)의 상품은 네이버가
 * 판매기간을 **종료일 기준으로 다시 써서** 돌려준다 — 2주짜리 회차가 `07.20 ~ 07.20`(하루)로,
 * 09.10~09.16 회차가 `09.16 ~ 09.17`(시작일 = 원래 종료일)로 왔다. **시작일이 못 쓰는 값이 되고
 * 종료일은 실제와 맞았다.** 오너 신고(2026-09-17): 그 값을 판매관리에 반영해 회차 시작일이
 * 망가지는 사고가 실제로 났다.
 *
 * ⛔ 이 상수를 넓혀 다른 상태까지 '판매중'으로 취급하지 말 것. 같은 계열의 선례가 이미 있다 —
 * `campaigns-handler` 가 `WAIT`·`SUSPENDED`·`OUTOFSTOCK` 의 14일짜리 기본 기간을 '미등록'으로
 * 걸러낸다(네이버가 기간을 합성하는 또 다른 모양).
 */
export const STORE_PERIOD_TRUSTED_STATUS = 'SALE';

/** 스토어 관측 기간이 집계 창과 어긋난 상태. `resolveStorePeriodDrift` 참조. */
export type StorePeriodDrift = {
  /**
   * 무엇을 맞출 수 있는가.
   * - `full` 스토어가 판매중 — 시작일·종료일 둘 다.
   * - `end-only` 판매가 끝난 상태라 시작일은 재작성돼 믿을 수 없다 — **종료일만**.
   */
  scope: 'full' | 'end-only';
  /** 화면에 보여줄 스토어 값. `full` 이면 기간 전체, `end-only` 면 종료일 하나. */
  storeLabel: string;
  /** 판매캠페인 PATCH 에 넘길 시작일(KST). `end-only` 면 **null — 보내지 않는다.** */
  storeStartYmd: string | null;
  /** 종료 미정('계속')이면 null — 그 경우 판매관리 종료일을 맞출 근거가 없다. */
  storeEndYmd: string | null;
  /** 맞출 대상 판매캠페인(전원 미락 — 아래 판정이 락이 섞인 캠페인 자체를 걸러낸다). */
  salesCampaignIds: string[];
};

/**
 * 스토어(네이버) 판매기간이 **집계 창과 다른가**를 판정한다(순수).
 *
 * 왜 필요한가: 집계 창의 정본은 판매관리 일정이고 스토어 기간은 관측값이라(오너 확정
 * 2026-07-15), 스토어에서 기간을 연장·단축해도 주문관리 화면과 매출 집계는 그대로다.
 * 그 상태가 **화면에 아무 흔적도 남기지 않는 것**이 오너가 "등록 당시 값으로 고정돼 있다"고
 * 본 실체다(2026-09-17). 정본을 뒤집는 대신 어긋남을 드러내 오너가 한 번에 맞추게 한다.
 *
 * ⛔ 이 함수를 스토어 기간을 창으로 **승격**하는 데 쓰지 말 것 — 스토어는 '종료 후 별도
 * 주문건을 받으려고 임시로 판매를 여는' 운영 때문에 실제 회차 경계와 어긋나고, 그 값이
 * 자동으로 흘러들면 정산서·구글 캘린더·재구매 집계까지 오염된다(제거된 `syncSalesCampaignPeriod`).
 *
 * 비교는 **같은 포맷터를 통과한 문자열**로 한다 — 한쪽은 KST 자정, 다른 쪽은 스토어 정밀
 * 시각처럼 저장 형태가 달라도 같은 달력일이면 같은 기간이기 때문이다.
 * 창이 없으면(판매캠페인 미연결) null — 그땐 `salePeriod` 가 이미 화면에 그대로 나온다.
 *
 * ⚠️ **판매가 끝난 상태면 종료일만 본다**(오너 결정 2026-09-17 — `STORE_PERIOD_TRUSTED_STATUS`
 * 주석의 실측 근거). 그 구간의 스토어 시작일은 네이버가 다시 쓴 값이라, 시작일 차이는 어긋남으로
 * 세지 않는다 — 세면 **영원히 사라지지 않는 배지**가 되고, 누르면 회차 시작일이 망가진다.
 */
export function resolveStorePeriodDrift(camp: {
  salePeriod?: string | null;
  productStatus?: string | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  salesCampaigns?: Array<{ id: string; status?: string | null }> | null;
}): StorePeriodDrift | null {
  const windowLabel = formatKstPeriodLabel(camp.windowStartMs, camp.windowEndMs);
  if (windowLabel === null) return null;

  const { startMs, endMs } = parseSalePeriodBounds(camp.salePeriod);
  if (startMs === null) return null; // '기간 미정'·'미등록'·null — 비교할 관측값이 없다

  const scope: StorePeriodDrift['scope'] =
    camp.productStatus === STORE_PERIOD_TRUSTED_STATUS ? 'full' : 'end-only';

  let storeLabel: string | null;
  let storeStartYmd: string | null;
  if (scope === 'full') {
    storeLabel = formatKstPeriodLabel(startMs, endMs);
    storeStartYmd = formatKstYmd(startMs);
    if (storeLabel === null || storeLabel === windowLabel) return null;
  } else {
    // 종료일만 비교·표시한다. 맞출 종료일이 없으면(스토어가 '계속') 할 일이 없다.
    if (endMs === null) return null;
    const windowEndMs = camp.windowEndMs;
    if (windowEndMs !== null && formatKstDateLabel(windowEndMs) === formatKstDateLabel(endMs)) return null;
    storeLabel = formatKstDateLabel(endMs);
    storeStartYmd = null;
  }

  // 맞출 수 있는 상태인지까지 여기서 판정한다 — 「다른가」와 「눌러서 바꿀 수 있는가」가 갈리면
  // 누를 것 없는 배지가 뜬다.
  //
  // ⛔ **창이 얼었으면 이 캠페인 전체를 뺀다**(`isCampaignPeriodFrozen` — 집계 창 동결과 **같은**
  // 술어를 쓴다). 미락 회차만 골라 PATCH 해 봤자 창이 얼려 있어 **화면이 움직이지 않고**, 배지는
  // 눌러도 사라지지 않는 무한 루프가 된다. 창 동결은 오너 결정(2026-07-15 「정산 시작 = 확정」)이라
  // 여기서 푸는 것이 아니다.
  // ⚠️ 그래서 이 구간의 스토어 변경은 **어느 표면에도 뜨지 않는다** — `periodFrozenDrift` 는
  // 판매관리 일정↔저장 창 차이만 보므로 스토어만 바뀐 경우를 덮지 못한다. 알고 택한 값이다.
  const salesCampaigns = camp.salesCampaigns ?? [];
  if (salesCampaigns.length === 0) return null; // 연결이 없으면 salePeriod 가 이미 화면값이다
  if (isCampaignPeriodFrozen(salesCampaigns)) return null;
  const salesCampaignIds = salesCampaigns.map((sc) => sc.id);

  return {
    scope,
    storeLabel,
    storeStartYmd,
    storeEndYmd: endMs === null ? null : formatKstYmd(endMs),
    salesCampaignIds,
  };
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
 * 회차가 **확정(정산 락)** 됐는지. 정산대기(SETTLEMENT_WAIT)까지는 반품·구매확정으로 값이
 * 움직이므로 락이 아니고, 정산중/정산완료/드랍부터 확정이다(오너 확정 2026-07-15).
 *
 * 종전에는 mapping-service에 있었는데 그쪽은 prisma를 import하므로, 순수 함수인 조회창 계산이
 * 쓰려면 여기로 내려와야 했다(mapping-service가 그대로 재노출하므로 호출부는 바뀌지 않는다).
 * 상태 목록의 사본을 만들지 말 것 — 이 레포에서 상태 집합을 손으로 베낀 곳은 예외 없이 갈렸다.
 *
 * null/undefined(미선택·미확정, 또는 **select에서 status가 빠진 경우**)는 락 아님으로 취급한다 —
 * `status.toUpperCase()` 크래시 방어인 동시에, 조회창 계산에서는 "모르면 좁히지 않는다"는
 * fail-safe 방향이기도 하다(모름을 '끝난 회차'로 읽으면 발주서에서 주문이 조용히 빠진다).
 */
export function isSalesCampaignLocked(status: string | null | undefined): boolean {
  if (status == null) return false;
  const lockedStatuses = ['SETTLEMENT_IN_PROGRESS', 'COMPLETED', 'DROPPED'];
  return lockedStatuses.includes(status.toUpperCase());
}

/**
 * 조회창 시작일 계산에 기여할 판매캠페인만 남긴다 — **끝난 회차(정산 락)는 뺀다.**
 *
 * 실사고(2026-09-16): 2차 주문캠페인에 1차 판매캠페인 3건(6/12 시작, 완료·정산중)이 아직
 * 연결돼 있어, 캠페인 기간이 9/10~9/16인데 주문확인이 **6/12부터 97일**을 훑었다(실측:
 * 네이버 조회 13회 + 생략 84일 · 53초). 창은 연결된 판매캠페인 시작일의 **최솟값**이라
 * 지난 회차가 붙어 있기만 해도 그만큼 앞으로 끌린다. 증상이 "주문확인이 느리다" 뿐이라
 * 조용히 누적된다.
 *
 * 제외 기준은 **새로 만들지 않고 정산 락(`isSalesCampaignLocked`)을 그대로 쓴다** — 오너가
 * 이미 "정산중·완료·드랍이면 그 회차는 확정이므로 더 조회하지 않는다"로 정한 경계다
 * (2026-07-15 · T-140 Progressive Lock). 상태 집합의 사본이 생기는 순간 갈라진다.
 * ⛔ 마감(`CLOSED`)·정산대기는 빼지 않는다 — 판매 종료 직후 결제분이 아직 발주 대상이다.
 *
 * ⚠️ **전부 끝난 회차면 아무것도 빼지 않는다.** 제외가 후보를 0으로 만들면 창이 저장 창이나
 * 기본 창(오늘-14일)으로 떨어져 **발주서에서 주문이 조용히 빠질 수 있다**(P0). 창을 좁히는
 * 것은 살아있는 회차가 창을 붙들고 있을 때뿐이라는 뜻이다.
 *
 * ⚠️ 이 필터를 `resolveSalesCampaignWindow` 자체에 넣지 말 것 — 그쪽은 **집계 창**(캠페인의
 * startDate/endDate 정본)을 만들고, 그 창은 "연결된 전부를 min~max로 합성하되 어긋나면
 * 경고"가 오너 결정이다(P7). 여기서 거르는 것은 **조회창** 하나뿐이다.
 */
function resolveQueryWindowContributors<T extends { status?: string | null }>(
  salesCampaigns: T[] | null | undefined,
): T[] | null | undefined {
  if (!salesCampaigns || salesCampaigns.length === 0) return salesCampaigns;
  const live = salesCampaigns.filter((sc) => !isSalesCampaignLocked(sc.status));
  return live.length > 0 ? live : salesCampaigns;
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
 * 걸러내므로 결과는 정확하고 비용만 조금 는다.
 *
 * ⛔ 종전 주석의 "조회창 상한 MAX_DAYS로 이미 봉인"은 **사실이 아니다**(SUPERSEDED). now 상대
 * 하한은 조회 구간을 조용히 갉아먹어 제거됐고 `live-window-floor.contract.test.ts`가 부활을
 * 막는다 — 즉 창을 넓히는 실수에는 **비용 상한이 없다.** 2026-09-16 실사고에서 한 캠페인이
 * 97일을 훑은 것이 그 결과다(아래 `resolveQueryWindowContributors` 참조).
 *
 * 그래서 후보 판매캠페인은 `resolveQueryWindowContributors`가 한 번 거른다 — **끝난 회차(정산
 * 락)는 시작일을 앞으로 끌지 못한다.** 저장 창(`storedStart`)은 거르지 않는다: 그건 이 캠페인이
 * 스스로 선언한 창이라 위 불변식(조회창 ≤ 컷오프)의 바닥이다.
 */
export function resolveCampaignQueryStartMs(camp: {
  startDate?: Date | string | null;
  salePeriod?: string | null;
  salesCampaigns?: Array<{
    startDate?: Date | string | null;
    endDate?: Date | string | null;
    status?: string | null;
  }> | null;
}): number | null {
  // 저장된 창(startDate → salePeriod 폴백) — 컷오프가 실제로 읽는 값.
  const storedStart = resolveSaleWindowStartMs(camp);

  // 판매관리 창(정본). 동기화가 아직 안 닿았거나 동결된 캠페인에서도 컷오프를 놓치지 않게 함께 본다.
  const salesWindow = resolveSalesCampaignWindow(resolveQueryWindowContributors(camp.salesCampaigns));
  const salesStart =
    salesWindow === null
      ? null
      : isDayBoundaryMs(salesWindow.startMs)
        ? startOfKstDayMs(salesWindow.startMs)
        : salesWindow.startMs;

  if (storedStart !== null && salesStart !== null) return Math.min(storedStart, salesStart);
  return storedStart ?? salesStart ?? null;
}
