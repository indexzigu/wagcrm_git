/**
 * Apify 댓글 수집 지출 — 월별 집계(읽기 전용, 순수).
 *
 * 오너의 질문은 하나다: **"이번 달 지출이 무료 크레딧을 넘었나."**
 * 판정선이 계정(토큰)당 월 $5 이므로 풀 합계만 보면 오판한다 — 크레딧은 계정 간에
 * 이동하지 않아서, 합계가 여유로워도 특정 계정 하나가 이미 소진돼 그 계정으로 도는
 * 호출만 실패할 수 있다. 그래서 **토큰 지문별 분해가 기본**이고 합계는 참고값이다.
 *
 * I/O 는 `scripts/report-apify-comment-usage.ts` 가 맡고 여기엔 순수 로직만 둔다.
 */
import { estimateCommentCostUsd, APIFY_FREE_CREDIT_USD_PER_MONTH } from './apify-comment-usage';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `ApiCallLog` 에서 집계에 필요한 열만 (스크립트가 select 로 좁혀 읽는다) */
export type CommentUsageLogRow = {
  calledAt: Date;
  success: boolean;
  statusCode: number;
  errorMessage: string | null;
  metadata: string | null;
};

export type TokenUsage = {
  /** 비가역 지문. 기록 전 실패(토큰 미설정)는 null 로 모인다. */
  tokenFingerprint: string | null;
  calls: number;
  failures: number;
  receivedComments: number;
  estimatedCostUsd: number;
  /** 계정당 무료 크레딧을 넘었는지 */
  overFreeCredit: boolean;
};

export type MonthlyUsageSummary = {
  /** KST 기준 "YYYY-MM" */
  month: string;
  calls: number;
  failures: number;
  /** 0~1 */
  failureRate: number;
  targetPosts: number;
  receivedComments: number;
  filledPosts: number;
  /** 받았지만 게시물에 귀속 못 한 수 = 돈만 쓴 분량 */
  unattributedPosts: number;
  estimatedCostUsd: number;
  avgDurationMs: number;
  byToken: TokenUsage[];
  /** 실패 사유 빈도순 */
  topErrors: Array<{ reason: string; count: number }>;
  /** metadata 파싱 실패 행 수 — 0이 아니면 아래 수치가 과소계상이다(삼키지 않는다) */
  malformedRows: number;
};

/** KST 달력 기준 월 키. UTC 로 끊으면 매월 1일 오전 9시 이전 호출이 앞 달로 샌다. */
export function kstMonthKey(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** KST 기준 최근 N개월의 시작 시각(UTC Date) — 조회 창을 좁히는 용도 */
export function kstMonthStartUtc(now: Date, monthsBack: number): Date {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const start = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - monthsBack, 1, 0, 0, 0, 0);
  return new Date(start - KST_OFFSET_MS);
}

type ParsedMetadata = {
  targetPosts: number;
  receivedComments: number;
  filledPosts: number;
  unattributedPosts: number;
  durationMs: number;
  estimatedCostUsd: number;
  tokenFingerprint: string | null;
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** metadata JSON 파싱. 실패하면 null 을 돌려주고 호출부가 malformedRows 로 센다. */
export function parseUsageMetadata(raw: string | null): ParsedMetadata | null {
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const receivedComments = num(obj.receivedComments);
  return {
    targetPosts: num(obj.targetPosts),
    receivedComments,
    filledPosts: num(obj.filledPosts),
    unattributedPosts: num(obj.unattributedPosts),
    durationMs: num(obj.durationMs),
    // 기록 당시 단가를 보존한다. 없을 때만 현재 단가로 유도(단가가 바뀌어도 과거가 안 흔들린다).
    estimatedCostUsd:
      typeof obj.estimatedCostUsd === 'number' && Number.isFinite(obj.estimatedCostUsd)
        ? obj.estimatedCostUsd
        : estimateCommentCostUsd(receivedComments),
    tokenFingerprint: typeof obj.tokenFingerprint === 'string' ? obj.tokenFingerprint : null,
  };
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * 행 목록을 KST 월별로 접는다. 최신 월이 먼저 온다.
 * `freeCreditUsd` 는 계정(토큰)당 월 무료 크레딧 — 판정선을 바꾸고 싶으면 여기만 조정한다.
 */
export function summarizeCommentUsageByMonth(
  rows: CommentUsageLogRow[],
  freeCreditUsd = APIFY_FREE_CREDIT_USD_PER_MONTH,
): MonthlyUsageSummary[] {
  const buckets = new Map<string, CommentUsageLogRow[]>();
  for (const row of rows) {
    const key = kstMonthKey(row.calledAt);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }

  const summaries: MonthlyUsageSummary[] = [];
  for (const [month, monthRows] of buckets) {
    const tokens = new Map<string, TokenUsage>();
    const errors = new Map<string, number>();
    let failures = 0;
    let targetPosts = 0;
    let receivedComments = 0;
    let filledPosts = 0;
    let unattributedPosts = 0;
    let estimatedCostUsd = 0;
    let durationTotal = 0;
    let durationSamples = 0;
    let malformedRows = 0;

    for (const row of monthRows) {
      if (!row.success) {
        failures += 1;
        const reason = (row.errorMessage ?? `HTTP ${row.statusCode}`).slice(0, 120);
        errors.set(reason, (errors.get(reason) ?? 0) + 1);
      }

      const meta = parseUsageMetadata(row.metadata);
      if (!meta) {
        malformedRows += 1;
        continue;
      }

      targetPosts += meta.targetPosts;
      receivedComments += meta.receivedComments;
      filledPosts += meta.filledPosts;
      unattributedPosts += meta.unattributedPosts;
      estimatedCostUsd += meta.estimatedCostUsd;
      durationTotal += meta.durationMs;
      durationSamples += 1;

      const key = meta.tokenFingerprint ?? '(unknown)';
      const entry = tokens.get(key) ?? {
        tokenFingerprint: meta.tokenFingerprint,
        calls: 0,
        failures: 0,
        receivedComments: 0,
        estimatedCostUsd: 0,
        overFreeCredit: false,
      };
      entry.calls += 1;
      if (!row.success) entry.failures += 1;
      entry.receivedComments += meta.receivedComments;
      entry.estimatedCostUsd += meta.estimatedCostUsd;
      tokens.set(key, entry);
    }

    const byToken = [...tokens.values()]
      .map((t) => ({
        ...t,
        estimatedCostUsd: round(t.estimatedCostUsd),
        overFreeCredit: t.estimatedCostUsd > freeCreditUsd,
      }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

    summaries.push({
      month,
      calls: monthRows.length,
      failures,
      failureRate: monthRows.length === 0 ? 0 : round(failures / monthRows.length, 4),
      targetPosts,
      receivedComments,
      filledPosts,
      unattributedPosts,
      estimatedCostUsd: round(estimatedCostUsd),
      avgDurationMs: durationSamples === 0 ? 0 : Math.round(durationTotal / durationSamples),
      byToken,
      topErrors: [...errors.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      malformedRows,
    });
  }

  return summaries.sort((a, b) => (a.month < b.month ? 1 : -1));
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * 한 달치를 사람이 읽는 블록으로 렌더한다(순수 — 스크립트는 I/O 셸일 뿐).
 *
 * `tokenIndex` = 지문 → 현 풀 인덱스. **`null` 은 "풀을 모른다"(env 미로드)**,
 * 빈 Map 은 "풀은 아는데 비어 있다"로 서로 다르다 — 구분하지 않으면 env 를 안 읽은
 * 실행에서 모든 계정이 '교체된 토큰'으로 잘못 찍힌다.
 */
export function formatMonthlyReport(
  summary: MonthlyUsageSummary,
  tokenIndex: Map<string, number> | null = null,
  freeCreditUsd = APIFY_FREE_CREDIT_USD_PER_MONTH,
): string {
  const lines: string[] = [];
  const failPct = (summary.failureRate * 100).toFixed(1);
  lines.push(
    `■ ${summary.month}: 호출 ${summary.calls}회 · 실패 ${summary.failures}회(${failPct}%) · 추정 ${usd(summary.estimatedCostUsd)}`,
  );
  lines.push(
    `   타깃 게시물 ${summary.targetPosts} → 수신 댓글 ${summary.receivedComments} → 채운 게시물 ${summary.filledPosts}` +
      (summary.unattributedPosts > 0 ? ` (귀속 실패 ${summary.unattributedPosts})` : ''),
  );
  lines.push(`   평균 소요 ${(summary.avgDurationMs / 1000).toFixed(1)}s`);

  lines.push(`   토큰별 (계정당 무료 크레딧 ${usd(freeCreditUsd)}):`);
  if (summary.byToken.length === 0) lines.push('     (기록 없음)');
  for (const t of summary.byToken) {
    const fp = t.tokenFingerprint;
    const slot = fp && tokenIndex ? tokenIndex.get(fp) : undefined;
    let label: string;
    if (!fp) label = '(호출 전 실패: 토큰 미설정)';
    else if (!tokenIndex) label = `지문 ${fp}`; // 풀 미상 — 교체 여부를 단정하지 않는다
    else if (slot === undefined) label = `#? ${fp} (현 풀에 없음: 교체된 토큰)`;
    else label = `#${slot} ${fp}`;
    const flag = t.overFreeCredit ? ' 🔴 무료 크레딧 초과' : '';
    lines.push(
      `     ${label.padEnd(38)} ${String(t.calls).padStart(3)}회 · ${usd(t.estimatedCostUsd).padStart(7)}${flag}`,
    );
  }

  if (summary.topErrors.length > 0) {
    lines.push('   실패 사유:');
    for (const e of summary.topErrors) lines.push(`     ${e.count}× ${e.reason}`);
  }
  if (summary.malformedRows > 0) {
    lines.push(`   ⚠️ metadata 파싱 실패 ${summary.malformedRows}행: 위 수치는 그만큼 과소계상이다.`);
  }

  // 합계는 참고값이되 **관측된 계정 수 × 크레딧**과 함께 보여준다 — 합계만 보면
  // "$6 썼으니 $5 넘었다"로 오판하기 쉽다(계정 2개면 예산은 $10이다).
  const over = summary.byToken.filter((t) => t.overFreeCredit).length;
  const accounts = summary.byToken.filter((t) => t.tokenFingerprint).length;
  const poolBudget = accounts * freeCreditUsd;
  const pooled = `합계 ${usd(summary.estimatedCostUsd)} / 관측 계정 ${accounts}개 × ${usd(freeCreditUsd)} = ${usd(poolBudget)}`;
  lines.push(
    over > 0
      ? `   ➜ 판정: 🔴 무료 크레딧 초과 계정 ${over}개, ${pooled}`
      : `   ➜ 판정: 🟢 계정별 초과 없음, ${pooled}`,
  );
  return lines.join('\n');
}
