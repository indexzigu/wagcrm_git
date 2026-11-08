// [셀러분석] 캠페인 게시물 「평소 대비 N배」 — 순수 로직(Prisma·HTTP 무의존, client-safe).
//
// 질문: 「이번 공구 게시물이 이 셀러 평소보다 잘 됐나?」 ER(좋아요÷팔로워)은 계정 크기에 끌려가서
// 이 질문에 답하지 못한다. 그래서 같은 계정·같은 지표(좋아요)끼리 비교한다.
//
// 평소(기준) = 셀러 최근 게시물(SellerAiProfile.aiTags.postsPreview, 최대 45개)에서 아래를 뺀 나머지의
//   좋아요 가운데 값(중앙값):
//   ① 좋아요 숨김 게시물 ② 좋아요 0 게시물 — 비Graph 수집 경로(scraper.ts)는 숨김을 0 으로 남기고
//      표시도 안 해서 숨김과 구별이 안 된다. 빼면 기준이 살짝 올라가 배수는 「덜」 나온다(부풀지 않는 쪽).
//   ③ 이 캠페인 수집 기간(시작−7일~마감+1일) 안 게시물 — 등록 여부와 무관(미검토 후보·무관 처리분 포함).
//      캠페인 자신을 평소에 섞지 않기 위해서다. ④ 이 캠페인에 등록된 게시물(기간 밖 수동 등록분 대비).
//   기간 앞뒤는 모두 평소로 본다 — 「캠페인 이전만」으로 좁히면 재분석이 프리뷰를 최근 게시물로 밀어내서
//   지난 캠페인 대부분이 판단 불가가 된다. 다른 공구·광고 게시물은 빼지 않는다(공구가 잦은 셀러는
//   그것이 평소다; is_gongu 는 정규식 추정이라 제외 필터로 쓸 만큼 정확하지 않다).
// 배수 = 게시물 좋아요 ÷ 평소 좋아요. 캠페인 요약도 평균이 아니라 게시물 좋아요의 가운데 값으로
//   (바이럴 1건이 요약을 끌고 가지 않게).
//
// 알려진 한계: 캠페인 게시물 좋아요는 마감+3일에 수집이 멈추므로(campaign-engagement-collector)
// 마감 직전 게시물은 덜 쌓인 상태로 비교된다.
//
// 왜 다른 후보가 아닌가(설계 정본: docs/private/specs/2026-11-08-campaign-post-vs-baseline.md):
// - SellersHistory.avgLikes/er 은 평균(바이럴 1건에 끌림)이고 표본 수가 없어 「표본 부족」을 못 가린다.
// - aiTags.metrics.engagement.medianLikes 는 숨김 게시물을 0 으로 세고 캠페인 게시물 자신도 포함한다.
//
// 값을 못 내면 숫자 대신 사유를 낸다(가짜 숫자 금지 — reach-display 의 「대시 대신 사유」 관례).
import { instagramShortcode } from "./instagram-embed";
import { formatReelViewMultiple } from "./seller-analysis/reach-display";

/** 가운데 값이 한 게시물에 크게 흔들리지 않는 최소 표본. 프리뷰 상한(45) 대비 정상 계정은 걸리지 않는다. */
export const BASELINE_MIN_SAMPLE = 5;
/** 캠페인 수집 기간 — 추천 피드·스토리 수집과 같은 값(campaign-suggested-posts leadDays 7 · trailDays 1,
 *  story-capture STORY_CAPTURE_PREROLL_DAYS·TRAIL_DAYS). 그 모듈은 서버 전용이라 값만 맞춘다. */
export const BASELINE_WINDOW_LEAD_DAYS = 7;
export const BASELINE_WINDOW_TRAIL_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 라우트가 내려주는 평소 표본 1건(슬림 — 캡션·댓글 원문 없음). */
export type BaselineSamplePost = {
  shortcode: string | null; // 인스타 shortcode(자기 제외 대조용). 파싱 불가면 null — 표본에는 남는다
  likes: number | null; // 숨김이면 null
  hidden: boolean;
  takenAt: string | null; // 게시 시각(ISO). 캠페인 기간 제외·표본 기간 표기에 쓴다
};

/** 라우트 응답의 평소 표본. analyzed=false 면 셀러 분석(프리뷰 수집) 전이다. */
export type BaselineSample = {
  analyzed: boolean;
  posts: BaselineSamplePost[];
};

export type BaselineUnavailableReason = "NOT_ANALYZED" | "ALL_HIDDEN" | "TOO_FEW" | "LOAD_FAILED";

export type LikesBaseline =
  | { ok: true; medianLikes: number; sampleSize: number; fromMs: number | null; toMs: number | null }
  | { ok: false; reason: BaselineUnavailableReason; sampleSize: number };

export type BaselineExclusion = {
  /** 이 캠페인(그룹 회차 포함)에 등록된 게시물 shortcode */
  ownShortcodes: ReadonlySet<string>;
  /** 캠페인 시작·마감(ISO 또는 yyyy-mm-dd). 없으면 기간 제외를 하지 않는다 */
  startDate?: string | null;
  endDate?: string | null;
};

type PreviewLike = {
  permalink?: unknown;
  likes?: unknown;
  likes_hidden?: unknown;
  taken_at?: unknown;
};

function epochOrNull(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * aiTags(Json)에서 평소 표본을 방어적으로 꺼낸다(서버 라우트용). 형태가 어긋난 항목은 버린다.
 * postsPreview 가 없거나 비면 analyzed=false.
 */
export function extractBaselineSample(aiTags: unknown): BaselineSample {
  if (!aiTags || typeof aiTags !== "object") return { analyzed: false, posts: [] };
  const preview = (aiTags as Record<string, unknown>).postsPreview;
  if (!Array.isArray(preview) || preview.length === 0) return { analyzed: false, posts: [] };
  const posts: BaselineSamplePost[] = [];
  for (const raw of preview as PreviewLike[]) {
    if (!raw || typeof raw !== "object") continue;
    const hidden = raw.likes_hidden === true;
    const likes = typeof raw.likes === "number" && Number.isFinite(raw.likes) && raw.likes >= 0 ? raw.likes : null;
    // 숨김이 아닌데 좋아요 숫자가 없으면 표본 자격이 없다(0 으로 메우지 않는다).
    if (!hidden && likes === null) continue;
    posts.push({
      shortcode: typeof raw.permalink === "string" ? instagramShortcode(raw.permalink) : null,
      likes: hidden ? null : likes,
      hidden,
      takenAt: epochOrNull(raw.taken_at) !== null ? (raw.taken_at as string) : null,
    });
  }
  return { analyzed: posts.length > 0, posts };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 캠페인 날짜(달력 날짜 = 값의 UTC 날짜 부분. "yyyy-mm-dd" 와 UTC 자정 ISO 둘 다)를 그날 KST 자정으로.
 * UTC 자정 그대로 쓰면 KST 09시라 창 시작이 9시간 좁아진다.
 */
function kstDayStart(v: string | null): number | null {
  const t = epochOrNull(v);
  if (t === null) return null;
  return Date.parse(`${new Date(t).toISOString().slice(0, 10)}T00:00:00+09:00`);
}

/** 캠페인 수집 기간 [시작−7일, 마감+1일](KST 날짜 단위). 한쪽만 있으면 그 경계만(추천 피드와 같은 규칙). */
function campaignWindow(ex: BaselineExclusion): { lo: number | null; hi: number | null } {
  const start = kstDayStart(ex.startDate ?? null);
  const end = kstDayStart(ex.endDate ?? null);
  const lo = start !== null ? start - BASELINE_WINDOW_LEAD_DAYS * DAY_MS : null;
  // 마감일은 KST 자정이므로 하루를 더해 마감일 당일 전체 + trail 일(당일 포함)까지 덮는다 — 상한은 미포함 경계.
  const hi =
    end !== null
      ? end + (BASELINE_WINDOW_TRAIL_DAYS + 1) * DAY_MS
      : start !== null
        ? start + (BASELINE_WINDOW_TRAIL_DAYS + 1) * DAY_MS
        : null;
  return { lo, hi };
}

/** 평소 좋아요(가운데 값)를 계산한다. sample=null 은 조회 실패. */
export function computeLikesBaseline(sample: BaselineSample | null, ex: BaselineExclusion): LikesBaseline {
  if (sample === null) return { ok: false, reason: "LOAD_FAILED", sampleSize: 0 };
  if (!sample.analyzed || sample.posts.length === 0) {
    return { ok: false, reason: "NOT_ANALYZED", sampleSize: 0 };
  }
  const { lo, hi } = campaignWindow(ex);
  const others = sample.posts.filter((p) => {
    if (p.shortcode && ex.ownShortcodes.has(p.shortcode)) return false;
    const t = epochOrNull(p.takenAt);
    if (t !== null && (lo !== null || hi !== null)) {
      const inWindow = (lo === null || t >= lo) && (hi === null || t < hi);
      if (inWindow) return false;
    }
    return true;
  });
  // 숨김과 0(숨김과 구별 불가)은 표본 밖.
  const usable = others.filter((p): p is BaselineSamplePost & { likes: number } => !p.hidden && p.likes !== null && p.likes > 0);
  if (usable.length === 0 && others.length > 0) {
    return { ok: false, reason: "ALL_HIDDEN", sampleSize: 0 };
  }
  if (usable.length < BASELINE_MIN_SAMPLE) {
    return { ok: false, reason: "TOO_FEW", sampleSize: usable.length };
  }
  const times = usable.map((p) => epochOrNull(p.takenAt)).filter((t): t is number => t !== null);
  return {
    ok: true,
    medianLikes: median(usable.map((p) => p.likes)),
    sampleSize: usable.length,
    fromMs: times.length > 0 ? Math.min(...times) : null,
    toMs: times.length > 0 ? Math.max(...times) : null,
  };
}

/** 인스타 게시물인가 — 다른 플랫폼 좋아요를 인스타 평소와 비교하지 않는다(데모의 instagram.example.com 포함). */
export function isInstagramLikeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /(^|\.)instagram\./.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 게시물 1건의 평소 대비 배수. 좋아요가 없거나(숨김·집계 전) 기준이 없거나 인스타가 아니면 null. */
export function postVsBaseline(
  likes: number | null,
  baseline: LikesBaseline,
  url: string | null | undefined,
): number | null {
  if (!baseline.ok || likes === null || !Number.isFinite(likes) || !isInstagramLikeUrl(url)) return null;
  return likes / baseline.medianLikes;
}

/** 캠페인 요약 — 비교 가능한 게시물 좋아요의 가운데 값 ÷ 평소. 비교 가능한 게시물이 없으면 null. */
export function campaignVsBaseline(
  posts: ReadonlyArray<{ likes: number | null; externalUrl: string | null }>,
  baseline: LikesBaseline,
): { multiple: number; postCount: number } | null {
  if (!baseline.ok) return null;
  const likes = posts
    .filter((p) => isInstagramLikeUrl(p.externalUrl))
    .map((p) => p.likes)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  if (likes.length === 0) return null;
  return { multiple: median(likes) / baseline.medianLikes, postCount: likes.length };
}

/** 「1.8배」 — 숫자 형식은 릴스 조회 배수와 같은 규칙(1 미만 둘째 자리, 10 이상 정수). */
export function formatBaselineMultiple(v: number): string {
  return `${formatReelViewMultiple(v)}배`;
}

function monthDay(ms: number): string {
  // KST 기준 표기(운영자 시간대) — 서버·클라 시간대와 무관하게 같은 글자.
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}.${d.getUTCDate()}`;
}

/** 요약 카드의 근거 한 줄(값이 있을 때). 표본 기간이 있으면 함께. */
export function baselineBasisLine(baseline: LikesBaseline): string | null {
  if (!baseline.ok) return null;
  const range =
    baseline.fromMs !== null && baseline.toMs !== null
      ? ` (${monthDay(baseline.fromMs)}~${monthDay(baseline.toMs)})`
      : "";
  return `평소 좋아요 ${Math.round(baseline.medianLikes).toLocaleString()} · 게시물 ${baseline.sampleSize}개${range}`;
}

/** 요약 카드의 판단 불가 사유 한 줄. 값이 있으면 null. */
export function baselineUnavailableLine(baseline: LikesBaseline): string | null {
  if (baseline.ok) return null;
  switch (baseline.reason) {
    case "NOT_ANALYZED":
      return "셀러 분석 전";
    case "ALL_HIDDEN":
      return "평소 좋아요 비공개";
    case "TOO_FEW":
      return `평소 게시물 ${baseline.sampleSize}개 · ${BASELINE_MIN_SAMPLE}개부터 계산`;
    case "LOAD_FAILED":
      return "평소 수치를 불러오지 못함";
  }
}
