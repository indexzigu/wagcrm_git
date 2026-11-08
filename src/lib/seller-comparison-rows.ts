// 셀러 비교표 — 행 정의·최고값 판정 SSOT (순수·client-safe, Prisma 무의존).
//
// 이 화면이 돕는 판단: 「후보 3~5명 중 누구에게 먼저 제안하나」. 그래서 우리와의 실적이 맨 위다.
// 설계 정본: docs/private/specs/2026-11-08-seller-reach-similar-compare.md §3 (로컬 서고).
//
// ⛔ 새 지표 계산을 여기서 만들지 말 것 — 값은 전부 기존 SSOT 를 거친다:
//   실적 = summarizeSellerSalesPerformance(그룹 1건 접기 = countEffectiveCampaigns) ·
//   마지막 진행 = tallySellerRuns + computeDormancyTier(목록 「마지막 진행」과 같은 모수) ·
//   팔로워 증감 = computeFollowerGrowthRate · 분석 지표 = normalizeMetrics(릴스 조회 배수 = metrics.reach 포함) ·
//   위험 신호 = computeRiskFlags.
//
// 최고값 강조는 「높을수록 좋다」가 분명한 행만 받는다. 광고 비중·공구 비중·경과일·종합점수·팔로워는
// 높다고 좋은 것이 아니거나(비중) 판단 근거로 확인되지 않아(종합점수, 매출과의 순위상관 미확인) 강조하지 않는다.

import { computeFollowerGrowthRate } from "./seller-scorecard";
import { summarizeSellerSalesPerformance, type SellerSalesRow } from "./seller-sales-performance";
import { computeDormancyTier, tallySellerRuns } from "./seller-dormancy";
import { RUN_STATUSES } from "./recampaign-timing";
import { sellerDisplayName } from "./seller-display-name";
import { normalizeMetrics } from "./seller-analysis/scores";
import { computeRiskFlags, type ProfileMeta, type RiskFlag } from "./seller-analysis/riskFlags";
import type { PostPreview } from "./seller-analysis/types";
import type { SellerMetrics } from "./seller-analysis/metrics";
import { formatReelViewMultiple, reachReasonWord } from "./seller-analysis/reach-display";

/** 한 화면에 비교하는 최대 셀러 수 — 1280px 에 라벨 열 + 셀러 열 8개가 들어가는 폭(§3-2). */
export const SELLER_COMPARE_MAX = 8;
/** 비교가 성립하는 최소 셀러 수. */
export const SELLER_COMPARE_MIN = 2;
/** 최고값 강조가 의미를 갖는 최소 비교 대상 수 — 2열 이하에서 「최고」는 그냥 「더 큰 쪽」이다. */
export const BEST_VALUE_MIN_CANDIDATES = 3;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface NormalizedComparisonIds {
  /** 중복 제거·형식 검사·상한 적용 뒤의 id (주소 순서 유지) */
  ids: string[];
  /** 형식이 틀렸거나 상한(8명)을 넘어 뺀 개수 — DB 에 없는 id 는 로더가 따로 센다 */
  droppedCount: number;
}

/** `?ids=a,b,c` → 비교 대상 id. 배열(같은 키 반복)도 받는다. */
export function normalizeComparisonIds(
  raw: string | readonly string[] | null | undefined,
): NormalizedComparisonIds {
  const tokens = (Array.isArray(raw) ? raw : [raw ?? ""])
    .flatMap((part) => String(part).split(","))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];
  let invalid = 0;
  for (const token of tokens) {
    if (!ID_PATTERN.test(token)) {
      invalid += 1;
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    valid.push(token);
  }

  const ids = valid.slice(0, SELLER_COMPARE_MAX);
  return { ids, droppedCount: invalid + (valid.length - ids.length) };
}

/**
 * 목록에서 비교 대상을 담을 때의 상한 판정. 9번째를 담으려 하면 담지 않고 limitHit 을 켠다
 * (토스트 대신 선택 바 문구로 알린다 — §3-1). 빼는 동작은 언제나 통과한다.
 */
export function applyCompareSelection(
  current: readonly string[],
  next: readonly string[],
): { ids: string[]; limitHit: boolean } {
  if (next.length > SELLER_COMPARE_MAX && next.length > current.length) {
    return { ids: [...current], limitHit: true };
  }
  return { ids: [...next], limitHit: false };
}

/** 비교 화면 주소 — 목록 선택 바와 비교표의 「빼기」가 같은 형식을 쓴다. */
export function sellerCompareHref(ids: readonly string[]): string {
  return `/sellers/compare?ids=${ids.map(encodeURIComponent).join(",")}`;
}

// ---------- 로더 → 화면 사이의 원재료 (직렬화 가능 — "use cache" 경계를 넘는다) ----------

export interface SellerComparisonCampaign {
  actualSales: number | null;
  sellerFeeBasisOverride: number | null;
  sellerMarginRate: number | null;
  campaignDeals: { sellerMarginRate: number | null }[];
  groupId: string | null;
  status: string;
  /** ISO 문자열. 시작일 미정이면 null */
  startDate: string | null;
}

export interface SellerComparisonAnalysis {
  analyzedAt: string | null;
  compositeScore: number | null;
  confidence: string | null;
  /** aiTags.category (Gemini 가 지정한 주 카테고리) */
  category: unknown;
  /** aiTags.metrics (SellerMetrics JSON) */
  metrics: unknown;
  /** aiTags.profileMeta */
  profileMeta: unknown;
  /** aiTags.postsPreview 에서 위험 신호 판정에 쓰는 두 필드(taken_at·is_gongu)만 */
  postsLite: unknown;
}

export interface SellerComparisonSource {
  id: string;
  name: string;
  alias: string | null;
  currentFollowers: number;
  fitLevel: string | null;
  analysis: SellerComparisonAnalysis | null;
  campaigns: SellerComparisonCampaign[];
  /** 최근 2개월 팔로워 스냅샷 (30일 증감 계산용) */
  followerSnapshots: { snapshotDate: string; followersCount: number }[];
}

// ---------- 표 모델 ----------

export interface ComparisonCell {
  text: string;
  /** 같은 칸 아래 작은 보조 줄(분모 등) */
  subText?: string;
  /** 최고값 판정에 쓰는 수치 — 값이 없거나 비교 불가면 null */
  numeric: number | null;
  /** 값은 있지만 표본이 얇아 「최고」 후보에서 뺀다 */
  insufficient: boolean;
  /** 값 대신 사유 낱말(미분석·미수집·0회 등)을 보이는 칸 */
  isReason: boolean;
  isBest: boolean;
}

export interface ComparisonRow {
  key: string;
  label: string;
  note?: string;
  cells: ComparisonCell[];
}

export type ComparisonSectionKey = "ours" | "scale" | "commerce" | "status" | "score";

export interface ComparisonSection {
  key: ComparisonSectionKey;
  label: string;
  /** 내부 전용(인쇄본에서 뺀다) */
  internal: boolean;
  rows: ComparisonRow[];
}

export interface ComparisonColumnHeader {
  id: string;
  displayName: string;
  riskFlags: RiskFlag[];
}

export interface ComparisonTable {
  columns: ComparisonColumnHeader[];
  sections: ComparisonSection[];
}

/**
 * 최고값 칸의 위치. 강조하지 않는 경우는 전부 null 이다 —
 * 비교 대상(값이 있고 표본이 충분한 칸)이 3개 미만 · 최댓값 동률 · 최댓값이 0 이하.
 */
export function pickBestIndex(
  cells: ReadonlyArray<Pick<ComparisonCell, "numeric" | "insufficient" | "text">>,
): number | null {
  const candidates = cells
    .map((cell, index) => ({ value: cell.numeric, insufficient: cell.insufficient, text: cell.text, index }))
    .filter(
      (c): c is { value: number; insufficient: boolean; text: string; index: number } =>
        c.value !== null && Number.isFinite(c.value) && !c.insufficient,
    );
  if (candidates.length < BEST_VALUE_MIN_CANDIDATES) return null;

  const max = Math.max(...candidates.map((c) => c.value));
  // "Best" of all-zero or all-negative values (e.g. every follower count shrank) is not good news.
  if (max <= 0) return null;
  const winner = candidates.find((c) => c.value === max)!;
  // Ties are judged on the rendered text, not the raw number: 4.44% vs 4.41% both render
  // "+4.4%", and bolding one of two identical-looking cells reads as a bug to the owner.
  const tiedOnScreen = candidates.filter((c) => c.value === max || c.text === winner.text);
  return tiedOnScreen.length === 1 ? winner.index : null;
}

// ---------- 열 파생 ----------

interface DerivedColumn {
  source: SellerComparisonSource;
  displayName: string;
  perf: ReturnType<typeof summarizeSellerSalesPerformance>;
  daysSinceLastRun: number | null;
  hasPastRun: boolean;
  growthRate: number | null;
  metrics: SellerMetrics | null;
  /** 분석 신뢰도 낮음 — 분석 지표 행에서 최고 후보로 세지 않는다 */
  lowConfidence: boolean;
  riskFlags: RiskFlag[];
}

function toSalesRows(campaigns: readonly SellerComparisonCampaign[]): SellerSalesRow[] {
  return campaigns.map((c) => ({
    actualSales: c.actualSales,
    sellerFeeBasisOverride: c.sellerFeeBasisOverride,
    sellerMarginRate: c.sellerMarginRate,
    campaignDeals: c.campaignDeals,
    groupId: c.groupId,
  }));
}

function deriveColumn(source: SellerComparisonSource, now: Date): DerivedColumn {
  const perf = summarizeSellerSalesPerformance(toSalesRows(source.campaigns));

  // 목록 「마지막 진행」과 같은 모수: 실행된 상태 ∩ 시작일 도래분, 그룹은 1회.
  const runRows = source.campaigns
    .filter((c) => RUN_STATUSES.has(c.status) && c.startDate !== null)
    .map((c) => ({ sellerId: source.id, groupId: c.groupId, rowCount: 1, lastStartAt: c.startDate }));
  const run = tallySellerRuns(runRows, now).get(source.id);
  const verdict = computeDormancyTier(run?.lastRunStartAt ?? null, now);

  const analysis = source.analysis;
  const metrics = analysis ? normalizeMetrics(analysis.metrics) : null;
  const profileMeta =
    analysis && analysis.profileMeta && typeof analysis.profileMeta === "object"
      ? (analysis.profileMeta as Partial<ProfileMeta>)
      : null;
  const postsLite = analysis && Array.isArray(analysis.postsLite) ? (analysis.postsLite as PostPreview[]) : [];

  return {
    source,
    displayName: sellerDisplayName(source),
    perf,
    daysSinceLastRun: verdict.daysSinceLastRun,
    hasPastRun: (run?.runCount ?? 0) > 0,
    growthRate: computeFollowerGrowthRate(source.followerSnapshots),
    metrics,
    lowConfidence: analysis?.confidence === "low",
    riskFlags: analysis ? computeRiskFlags(analysis.metrics, profileMeta, postsLite, now) : [],
  };
}

// ---------- 칸 서식 ----------

function valueCell(text: string, numeric: number | null, opts: { subText?: string; insufficient?: boolean } = {}): ComparisonCell {
  return {
    text,
    subText: opts.subText,
    numeric,
    insufficient: opts.insufficient ?? false,
    isReason: false,
    isBest: false,
  };
}

function reasonCell(text: string): ComparisonCell {
  return { text, numeric: null, insufficient: false, isReason: true, isBest: false };
}

function formatWon(won: number): string {
  if (won < 10_000) return `${Math.round(won).toLocaleString("ko-KR")}원`;
  return `${Math.round(won / 10_000).toLocaleString("ko-KR")}만원`;
}

function formatPct(ratio: number, digits: number): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 분석 지표 칸 — 분석본이 없으면 「미분석」, 있는데 값이 없으면 「미수집」. */
function analysisCell(
  col: DerivedColumn,
  pick: (m: SellerMetrics) => number | null,
  format: (v: number) => string,
): ComparisonCell {
  if (!col.metrics) return reasonCell("미분석");
  const v = pick(col.metrics);
  if (v === null) return reasonCell("미수집");
  return valueCell(format(v), v, { insufficient: col.lowConfidence });
}

function relativeDays(days: number): string {
  return days <= 0 ? "오늘" : `${days}일 전`;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

// ---------- 행 정의 ----------

interface RowDef {
  key: string;
  label: string;
  note?: string;
  /** 「높을수록 좋다」가 분명한 행만 true — 최고값 강조 대상 */
  higherIsBetter: boolean;
  cell: (col: DerivedColumn, now: Date) => ComparisonCell;
  /**
   * 열을 가로지르는 후처리(선택). 칸 하나만 봐서는 알 수 없는 판정 — 예: 릴스 조회 배수의
   * 조회수 원천이 열마다 다르면 「기준 다름」을 달고 최고값 강조를 끈다.
   */
  finalize?: (cells: ComparisonCell[], cols: DerivedColumn[]) => { cells: ComparisonCell[]; suppressBest?: boolean };
}

interface SectionDef {
  key: ComparisonSectionKey;
  label: string;
  internal: boolean;
  rows: RowDef[];
}

const SECTIONS: SectionDef[] = [
  {
    key: "ours",
    label: "우리와의 실적",
    internal: true,
    rows: [
      {
        key: "effectiveCampaigns",
        label: "진행 캠페인",
        higherIsBetter: true,
        cell: (col) =>
          col.perf.effectiveCount === 0
            ? reasonCell("0회")
            : valueCell(`${col.perf.effectiveCount}회`, col.perf.effectiveCount),
      },
      {
        key: "avgSales",
        label: "공구당 평균 매출",
        higherIsBetter: true,
        cell: (col) => {
          if (col.perf.effectiveCount === 0) return reasonCell("0회");
          if (col.perf.avgSalesPerCampaign === null) return reasonCell("미입력");
          // 분모는 실매출이 확인된 캠페인이다(미입력을 0원으로 평균 내지 않는 SSOT 계약의 표시면).
          return valueCell(formatWon(col.perf.avgSalesPerCampaign), col.perf.avgSalesPerCampaign, {
            subText: `매출 확인 ${col.perf.effectiveWithSales}건 기준`,
            // A single confirmed campaign is not an average; keep it out of the best-value race.
            insufficient: col.perf.effectiveWithSales < 2,
          });
        },
      },
      {
        key: "lastRun",
        label: "마지막 캠페인 경과",
        higherIsBetter: false,
        cell: (col) => {
          if (col.daysSinceLastRun !== null) return valueCell(relativeDays(col.daysSinceLastRun), col.daysSinceLastRun);
          return reasonCell(col.perf.effectiveCount === 0 ? "0회" : "진행전");
        },
      },
    ],
  },
  {
    key: "scale",
    label: "규모·반응",
    internal: false,
    rows: [
      {
        key: "followers",
        label: "팔로워",
        higherIsBetter: false,
        cell: (col) =>
          col.source.currentFollowers > 0
            ? valueCell(col.source.currentFollowers.toLocaleString("ko-KR"), col.source.currentFollowers)
            : reasonCell("미수집"),
      },
      {
        key: "followerGrowth",
        label: "30일 팔로워 증감",
        higherIsBetter: true,
        cell: (col) => {
          if (col.growthRate === null) return reasonCell("미수집");
          const sign = col.growthRate > 0 ? "+" : "";
          return valueCell(`${sign}${col.growthRate.toFixed(1)}%`, col.growthRate);
        },
      },
      {
        key: "engagementRate",
        label: "참여율",
        higherIsBetter: true,
        cell: (col) => analysisCell(col, (m) => m.engagement.er, (v) => formatPct(v, 2)),
      },
      {
        // [셀러분석] 팔로워 대비 릴스 조회 중앙값(metrics.reach). 조회수 원천(조회/재생)이 열마다 다르면
        // 같은 잣대가 아니므로 값 아래에 「기준 다름」을 달고, 최고값 강조도 하지 않는다.
        key: "reelViewMultiple",
        label: "릴스 조회 배수",
        higherIsBetter: true,
        cell: (col) => {
          if (!col.metrics) return reasonCell("미분석");
          const reach = col.metrics.reach;
          const reason = reachReasonWord(reach);
          if (reason !== null || !reach || reach.reelViewMultiple === null) return reasonCell(reason ?? "미수집");
          return valueCell(`${formatReelViewMultiple(reach.reelViewMultiple)}배`, reach.reelViewMultiple, {
            insufficient: col.lowConfidence,
          });
        },
        finalize: (cells, cols) => {
          const sources = new Set(
            cells.flatMap((cell, index) => (cell.isReason ? [] : [cols[index].metrics?.reach?.viewSource ?? null])),
          );
          if (sources.size <= 1) return { cells };
          return {
            cells: cells.map((cell) => (cell.isReason ? cell : { ...cell, subText: "기준 다름" })),
            suppressBest: true,
          };
        },
      },
      {
        key: "commentToLike",
        label: "댓글 반응률",
        higherIsBetter: true,
        cell: (col) => analysisCell(col, (m) => m.engagement.commentToLikeRatio, (v) => formatPct(v, 1)),
      },
    ],
  },
  {
    key: "commerce",
    label: "상업성",
    internal: false,
    rows: [
      {
        key: "adShare",
        label: "광고 비중",
        higherIsBetter: false,
        cell: (col) => analysisCell(col, (m) => m.ads.adShare, (v) => formatPct(v, 0)),
      },
      {
        key: "gonguShare",
        label: "공구 비중",
        higherIsBetter: false,
        cell: (col) => analysisCell(col, (m) => m.gongu.gonguShare, (v) => formatPct(v, 1)),
      },
      {
        // 값은 MonetizedMetrics(광고 ∪ 공구 글 ÷ 일상 글)다 — 라벨이 실제 분자와 같아야 한다
        // (styleseed 기계 검사 7, 수치 정직). 공구 단독 유지율로 읽히지 않게 「광고·공구글」이라 부른다.
        key: "monetizedRetention",
        label: "광고·공구글 반응 유지율",
        higherIsBetter: true,
        cell: (col) => {
          const cell = analysisCell(col, (m) => m.monetized.monetizedRetention, (v) => formatPct(v, 0));
          return cell.isReason ? cell : { ...cell, subText: "일상 글 대비" };
        },
      },
    ],
  },
  {
    key: "status",
    label: "상태",
    internal: false,
    rows: [
      {
        key: "fitLevel",
        label: "적합도",
        higherIsBetter: false,
        cell: (col) => (col.source.fitLevel ? valueCell(col.source.fitLevel, null) : reasonCell("미평가")),
      },
      {
        key: "category",
        label: "주 카테고리",
        higherIsBetter: false,
        cell: (col) => {
          const analysis = col.source.analysis;
          if (!analysis) return reasonCell("미분석");
          const category = typeof analysis.category === "string" ? analysis.category.trim() : "";
          return category ? valueCell(category, null) : reasonCell("미수집");
        },
      },
      {
        key: "analyzedAt",
        label: "마지막 분석",
        higherIsBetter: false,
        cell: (col, now) => {
          const analysis = col.source.analysis;
          if (!analysis) return reasonCell("미분석");
          const days = daysSince(analysis.analyzedAt, now);
          return days === null ? reasonCell("미수집") : valueCell(relativeDays(days), days);
        },
      },
    ],
  },
  {
    key: "score",
    label: "종합점수",
    internal: false,
    rows: [
      {
        key: "compositeScore",
        label: "종합점수",
        note: "매출과의 상관이 확인되지 않은 참고 점수",
        higherIsBetter: false,
        cell: (col) => {
          const score = col.source.analysis?.compositeScore ?? null;
          if (!col.source.analysis) return reasonCell("미분석");
          return score === null ? reasonCell("미수집") : valueCell(`${score}점`, score);
        },
      },
    ],
  },
];

/** 비교 원재료 → 표. 열 순서는 입력 순서(= 주소의 ids 순서)를 그대로 따른다. */
export function buildComparisonTable(
  sources: readonly SellerComparisonSource[],
  now: Date = new Date(),
): ComparisonTable {
  const columns = sources.map((source) => deriveColumn(source, now));

  const sections = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    internal: section.internal,
    rows: section.rows.map((row) => {
      const raw = columns.map((col) => row.cell(col, now));
      const { cells, suppressBest = false } = row.finalize ? row.finalize(raw, columns) : { cells: raw };
      const best = row.higherIsBetter && !suppressBest ? pickBestIndex(cells) : null;
      return {
        key: row.key,
        label: row.label,
        note: row.note,
        cells: cells.map((cell, index) => (index === best ? { ...cell, isBest: true } : cell)),
      };
    }),
  }));

  return {
    columns: columns.map((col) => ({
      id: col.source.id,
      displayName: col.displayName,
      riskFlags: col.riskFlags,
    })),
    sections,
  };
}

/** 강조 대상 행 key — 테스트·문서가 행 정의와 어긋나지 않게 정의에서 파생한다. */
export const HIGHER_IS_BETTER_ROW_KEYS: readonly string[] = SECTIONS.flatMap((s) =>
  s.rows.filter((r) => r.higherIsBetter).map((r) => r.key),
);
