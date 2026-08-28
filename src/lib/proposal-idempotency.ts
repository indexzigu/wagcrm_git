// 반복 실행 기안의 **멱등성 4종 세트** — 단일 진실 원천 (client-safe, 순수. Prisma 무의존).
//
// 정본은 `docs/marketing-skills/README.md` §3-2(로컬 전용 문서). 주기적으로 돌면서 사람에게
// 무언가를 띄우는 기능은 아래 4가지가 **전부** 있어야 한다 — 빠지면 같은 항목이 반복 노출돼
// **승인함이 마비되고 오너가 출력 전체를 무시하게 된다.**
//
//   ① 마지막 실행 마커 — 이 루프가 언제 마지막으로 돌았는가
//        → `SystemTaskStatus`(jobKey 단위)가 이미 제공한다. 크론 라우트가
//          `withSystemTaskStatus` 로 감싸면 자동 기록되므로 이 파일은 다루지 않는다.
//   ② 중복 제거 키 — `셀러id + 사유코드 + 딜id`
//        → `recampaign-proposal.ts` 의 `buildProposalDedupeKey`(D2 2단계에서 확장).
//   ③ 쿨다운 창 — 한 번 띄운 뒤 다시 띄우지 않는 기간. **아래 `PROPOSAL_COOLDOWN_DAYS`.**
//   ④ '이미 처리' 집합 — 사람이 보고 넘긴 항목을 기억해 다시 올리지 않는다.
//        → 아래 이력 조회가 **상태를 가리지 않고** 흡수한다(거부·승인·실행 전부 '처리됨').
//
// 또한 **점검 주기와 행동 조건을 분리**한다 — "매일 점검하되, 임계를 넘고 쿨다운 안에 접촉이
// 없을 때만 기안". 둘을 뭉개면 창을 놓치거나 스팸이 된다.

/**
 * 쿨다운 창 — D3(동일 캠페인 3개월 재진행 주기)이 셀러 관련 루프의 기본값이다.
 *
 * ⛔ 이 값을 재진행 도래 임계(`DORMANT_DAYS`)와 **한 상수로 합치지 말 것.** 지금은 우연히
 * 둘 다 90 이지만 답하는 질문이 다르다 — 저쪽은 "재진행할 때가 됐나"(도메인 임계),
 * 이쪽은 "얼마나 자주 말을 걸어도 되나"(노출 예산). 한쪽을 조정하면 다른 쪽이 딸려가야
 * 할 이유가 없다.
 */
export const PROPOSAL_COOLDOWN_DAYS = 90;

const DAY_MS = 86_400_000;

/** 아직 사람이 처리하지 않은 기안. */
const OPEN_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL"]);

export type ProposalHistoryRow = {
  /** dedup 키 — 호출부가 `readProposalDedupeKey` 로 뽑아 넣는다 */
  dedupeKey: string;
  status: string;
  /**
   * 이 기안의 **마지막 활동 시각**(생성 또는 상태 전이).
   *
   * ⚠️ 생성 시각이 아니라 활동 시각이어야 한다 — 100일 전에 올라와 **어제 거부된** 기안을
   * 생성 시각으로 재면 쿨다운이 이미 지나 하루 만에 다시 올라온다. 오너가 방금 넘긴 것을
   * 다음 날 또 들이미는 셈이다(오너 확정 2026-08-04: 거부는 쿨다운 3개월 뒤 재등장).
   */
  lastActivityAt: Date | string;
};

export type KeyHistory = { hasOpen: boolean; lastActivityMs: number | null };

export type SkipReason = "OPEN" | "COOLDOWN";

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** 기안 이력을 dedup 키 단위로 접는다. */
export function buildProposalHistory(
  rows: readonly ProposalHistoryRow[],
): Map<string, KeyHistory> {
  const byKey = new Map<string, KeyHistory>();
  for (const row of rows) {
    const entry = byKey.get(row.dedupeKey) ?? { hasOpen: false, lastActivityMs: null };
    if (OPEN_STATUSES.has(row.status)) entry.hasOpen = true;
    const ms = toMs(row.lastActivityAt);
    if (Number.isFinite(ms) && (entry.lastActivityMs === null || ms > entry.lastActivityMs)) {
      entry.lastActivityMs = ms;
    }
    byKey.set(row.dedupeKey, entry);
  }
  return byKey;
}

/** 이 키를 지금 기안해도 되는가. */
export function decideProposable(
  dedupeKey: string,
  history: ReadonlyMap<string, KeyHistory>,
  now: Date = new Date(),
): { eligible: true } | { eligible: false; skipReason: SkipReason } {
  const entry = history.get(dedupeKey);
  if (!entry) return { eligible: true };
  // ② 열린 기안이 있으면 나이와 무관하게 막는다 — 쿨다운이 지났어도 중복이다.
  if (entry.hasOpen) return { eligible: false, skipReason: "OPEN" };
  if (entry.lastActivityMs === null) return { eligible: true };
  const elapsedDays = Math.floor((now.getTime() - entry.lastActivityMs) / DAY_MS);
  // ③④ 처리 여부를 가리지 않는다 — 거부·승인·실행 전부 "한 번 띄웠다"로 센다.
  if (elapsedDays < PROPOSAL_COOLDOWN_DAYS) return { eligible: false, skipReason: "COOLDOWN" };
  return { eligible: true };
}

export type SelectionResult<T> = {
  selected: T[];
  skippedOpen: number;
  skippedCooldown: number;
  /**
   * 상한에 걸려 이번 회차에서 빠진 수.
   *
   * ⚠️ 호출부는 이 값을 **반드시 로그·응답에 남긴다.** 조용한 절단은 "전부 처리했다"로
   * 읽히고, 상한에 상시로 걸리는 상태를 아무도 모르게 한다.
   */
  droppedByCap: number;
};

/**
 * 후보 목록에 ②③④를 적용하고 상한까지 자른다.
 *
 * 입력 순서가 곧 우선순위다 — 상한에 걸릴 때 앞쪽이 남는다. 호출부가 정렬해서 넘긴다.
 */
export function selectProposable<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  history: ReadonlyMap<string, KeyHistory>,
  options: { now?: Date; cap: number },
): SelectionResult<T> {
  const now = options.now ?? new Date();
  const eligible: T[] = [];
  let skippedOpen = 0;
  let skippedCooldown = 0;

  for (const item of items) {
    const decision = decideProposable(keyOf(item), history, now);
    if (decision.eligible) {
      eligible.push(item);
      continue;
    }
    if (decision.skipReason === "OPEN") skippedOpen += 1;
    else skippedCooldown += 1;
  }

  return {
    selected: eligible.slice(0, options.cap),
    skippedOpen,
    skippedCooldown,
    droppedByCap: Math.max(0, eligible.length - options.cap),
  };
}
