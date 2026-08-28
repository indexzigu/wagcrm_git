// 셀러 휴면 티어 판정 — 단일 진실 원천 (client-safe, 순수. Prisma 무의존).
//
// 축 = **마지막으로 진행이 시작된 캠페인 이후 경과일**(딜 무관). 오너 확정 D20:
//   건강 < 90일 · 휴면 90~180일 · 제외 180일+.
//
// ⛔ 개인 기준선(본인 평균 간격의 1.5×/2×)은 **폐기된 설계다**(D20) — 표본이 얇은
//    상태에서 개인 평균을 쓰면 "틀린 확신"이 된다. 상수는 아래 두 개뿐이고, 배수를
//    다시 들여오지 말 것.
//    ⚠️ 개인 케이던스(본인 간격 중앙값) 방식은 `src/lib/recampaign-timing.ts` 가
//    여전히 별도로 운영한다(영업 관리의 재캠페인 적기 카드). **두 모듈은 다른 질문에
//    답한다** — 이쪽은 "이 셀러와 얼마나 오래 거래가 없나"(절대 일수, 오너의 운영
//    기준), 저쪽은 "이 셀러의 평소 주기가 돌아왔나"(상대 케이던스). 통합하지 말 것.
//
// ⛔ `fitLevel`(계정 신호)과 이 티어(거래 실적)를 하나의 종합 점수로 합치지 않는다(D10) —
//    합치면 오너가 이미 아는 불일치가 숫자 뒤에 숨는다. 정렬·필터의 기본 기준으로도
//    쓰지 않는다(자동 판정 금지). 이 값은 **표시 전용 관찰 지표**다.
//
// 왜 "시작일"인가: D20 의 문장이 "어떤 캠페인도 3개월 이상 없음"이고, 같은 F1 계열의
// `recampaign-timing.ts` 도 "시작일이 도래한 것 = 실행됨"으로 실행을 정의한다. 종료일을
// 쓰면 같은 사실을 두 어휘로 재는 셈이라 두 화면의 숫자가 갈린다. (캠페인은 최대 30일
// 안쪽으로 운영되므로 두 기준의 차이는 최대 ~30일이다.)

import { tallyEffectiveCampaignCounts } from "@/lib/campaign-group-count";

const DAY_MS = 86_400_000;

/** 이 일수 이상 진행이 없으면 휴면 — 재접촉 검토 대상 (D20) */
export const DORMANT_DAYS = 90;
/** 이 일수 이상이면 사실상 제외 (D20). 단정적 예외 규칙은 아니다 */
export const EXCLUDE_DAYS = 180;

export type DormancyTier = "HEALTHY" | "DORMANT" | "EXCLUDED" | "UNKNOWN";

export type DormancyVerdict = {
  tier: DormancyTier;
  /** 마지막 진행 시작일로부터의 경과일. 판정 불가면 null (0 으로 취급하지 않는다) */
  daysSinceLastRun: number | null;
};

export const DORMANCY_TIER_LABEL: Record<DormancyTier, string> = {
  HEALTHY: "건강",
  DORMANT: "휴면",
  EXCLUDED: "제외",
  UNKNOWN: "판정 불가",
};

/**
 * 마지막 진행 시작일 → 휴면 티어.
 *
 * **과거 진행 0건은 '판정 불가'다 — 0일(=건강)로 취급하지 않는다.** `seller-fit.ts` 가
 * 고친 구 결함("미입력을 0점으로 합산해 평가 안 한 셀러가 낙제")과 같은 부류다.
 */
export function computeDormancyTier(
  lastRunStartAt: Date | string | null | undefined,
  now: Date = new Date(),
): DormancyVerdict {
  if (lastRunStartAt == null) return { tier: "UNKNOWN", daysSinceLastRun: null };

  const lastMs =
    lastRunStartAt instanceof Date ? lastRunStartAt.getTime() : Date.parse(lastRunStartAt);
  if (!Number.isFinite(lastMs)) return { tier: "UNKNOWN", daysSinceLastRun: null };

  const elapsedMs = now.getTime() - lastMs;
  // 미래 시작일은 '마지막 진행'이 아니다 — v1 이 밟은 함정(경과일 음수)을 여기서 끊는다.
  // 호출부(where 절)가 1차 방어이고 이건 벨트앤서스펜더다.
  if (elapsedMs < 0) return { tier: "UNKNOWN", daysSinceLastRun: null };

  const days = Math.floor(elapsedMs / DAY_MS);
  if (days >= EXCLUDE_DAYS) return { tier: "EXCLUDED", daysSinceLastRun: days };
  if (days >= DORMANT_DAYS) return { tier: "DORMANT", daysSinceLastRun: days };
  return { tier: "HEALTHY", daysSinceLastRun: days };
}

/**
 * Prisma `salesCampaign.groupBy({ by: ["sellerId","groupId"], _max: { startDate } })` 결과를
 * 셀러별 진행 신호로 접는다(행 fetch 없이 집계 쿼리 한 번 — P7 egress 규율).
 *
 * **호출부 계약:** `where` 로 ①RUN_STATUSES(실행된 상태) ②`startDate <= now` 를 이미 걸어
 * 넘긴다. 여기서 다시 거르지 않는 이유는 groupBy 버킷이 이미 접혀 있어 행 단위 판정이
 * 불가능하기 때문이다 — 다만 **미래 날짜가 `lastRunStartAt` 이 되는 것만은** 아래에서 막는다.
 */
export type SellerRunRow = {
  sellerId: string;
  groupId: string | null;
  /** 그룹 미소속(groupId === null) 버킷의 행 수. 그룹 버킷에서는 무시된다 */
  rowCount: number;
  /** 이 버킷의 가장 늦은 진행 시작일 */
  lastStartAt: Date | string | null;
};

export type SellerRunSignals = {
  /** 그룹을 1회로 접은 **과거 진행 횟수**. 누적 캠페인 수(전체 상태)와 다른 값이다 */
  runCount: number;
  /** ISO 문자열. 과거 진행이 없으면 null */
  lastRunStartAt: string | null;
};

export function tallySellerRuns(
  rows: readonly SellerRunRow[],
  now: Date = new Date(),
): Map<string, SellerRunSignals> {
  const nowMs = now.getTime();
  const byRows = new Map<string, SellerRunRow[]>();
  for (const row of rows) {
    const list = byRows.get(row.sellerId);
    if (list) list.push(row);
    else byRows.set(row.sellerId, [row]);
  }

  const result = new Map<string, SellerRunSignals>();
  for (const [sellerId, sellerRows] of byRows) {
    // 그룹 접기는 `tallyEffectiveCampaignCounts` 에 위임한다 — "그룹 = 1건" 의미를 이 파일이
    // 다시 구현하면 두 정의가 갈린다(codebase-map Code SSOT). 입력 형태(groupBy 결과)도 같다.
    const runCount = tallyEffectiveCampaignCounts(sellerRows).get(sellerId) ?? 0;

    let lastMs: number | null = null;
    for (const row of sellerRows) {
      if (row.lastStartAt == null) continue;
      const ms =
        row.lastStartAt instanceof Date ? row.lastStartAt.getTime() : Date.parse(row.lastStartAt);
      if (!Number.isFinite(ms) || ms > nowMs) continue; // 미래 시작일 방어
      if (lastMs === null || ms > lastMs) lastMs = ms;
    }

    result.set(sellerId, {
      runCount,
      lastRunStartAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    });
  }
  return result;
}
