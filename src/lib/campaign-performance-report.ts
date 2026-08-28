// campaign-performance-report — R6 캠페인 성과 피드백 리포트(내부용 MVP)의 순수 로직 코어.
// R5가 모은 "셀러 게시물" Asset(썸네일·캡션·좋아요는 R3 크론이 notes에 적립)과
// 캐시된 실적(매출·수량·주문수)·셀러 팔로워로 캠페인 성과를 stateless로 집계한다.
// Prisma·HTTP·네트워크 비의존 — asset-manager(클라이언트)가 이미 로드한 데이터로 계산한다.
// 신규 스키마·크론·의존성 0 (GROWTH_FLYWHEEL_PLAN.md §F2 · R6 백로그 §5 MVP).
//
// ⚠️ 우수 판정은 자동으로 하지 않는다(R6 §3 공통 교훈: 좋아요 절대값·매출 귀속은 함정 →
//    담당자 수동 Pick). 여기서는 ER 내림차순 정렬로 고성과를 자연 노출만 하고,
//    "우수" 판정 배지는 붙이지 않는다(승격은 기존 R5 "딜 레퍼런스로" 수동 버튼이 담당).
import { AUTO_NOTE_PREFIX } from "./reference-enrich";
import { instagramShortcode } from "./instagram-embed";

// buildAutoNote(reference-enrich.ts)가 좋아요를 붙일 때 쓰는 suffix ` · 좋아요 N`.
// 포맷의 SSOT은 buildAutoNote이며, 이 파서가 그 출력을 역파싱한다.
// (campaign-performance-report.test.ts가 buildAutoNote 출력으로 왕복 계약을 검증한다.)
const AUTO_NOTE_LIKES_SUFFIX = / · 좋아요 (\d+)$/;

/** 성과 집계에 필요한 최소 Asset 형태(R5 셀러 게시물). */
export type PerfPostInput = {
  id: string;
  fileName: string;
  externalUrl?: string | null;
  thumbnailUrl?: string | null;
  notes?: string | null;
  // 구조화 반응 지표(campaign-engagement-collector가 적재) — 있으면 notes 역파싱보다 우선.
  // 3-state: null=미집계 · 숫자=집계값 · likesHidden=true=좋아요 숨김(likeCount는 null).
  likeCount?: number | null;
  commentCount?: number | null;
  likesHidden?: boolean | null;
  // 표현 자산(크론/시딩 적재) — 유형 배지·포맷별 집계에 사용. 없으면 shortcode 맵 폴백.
  mediaType?: string | null;
};

/** 캠페인 실적 컨텍스트 — CampaignRow의 캐시 필드에서 온다(신규 집계 없음). */
export type CampaignPerfContext = {
  followers?: number | null; // Seller.currentFollowers — ER 분모
  actualSales?: number | null; // 캐시된 실매출
  itemCount?: number | null; // 캐시된 판매수량
  orderCount?: number | null; // 캐시된 주문수 — 객단가(AOV) 분모
};

export type PerfPost = {
  id: string;
  fileName: string;
  externalUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  likes: number | null; // 구조화 likeCount 우선, 없으면 notes 역파싱. 숨김·미집계면 null
  comments: number | null; // 구조화 commentCount만(레거시 notes에는 없음). 미집계면 null
  // 좋아요 숨김(오너 결정: 임의 숫자 금지 — 화면은 "비공개"로 표기). likes는 항상 null.
  likesHidden: boolean;
  mediaType: string | null; // 구조화 유형(reel/image/carousel/video/unknown) — 배지·포맷 집계용
  // ER(%) = 좋아요 / 팔로워 × 100. likes 또는 followers가 없으면 null(계산 불가).
  er: number | null;
};

export type CampaignPerformance = {
  posts: PerfPost[]; // ER 내림차순(계산 가능한 것 우선), 동률은 좋아요 내림차순, 안정 정렬
  postCount: number; // 발행량 — 미보관 셀러 게시물 수
  enrichedCount: number; // 좋아요가 집계된 게시물 수(notes 파싱 성공)
  totalLikes: number | null; // 합계(enriched만); enriched 0이면 null
  avgLikes: number | null; // 평균(enriched만)
  avgEr: number | null; // 평균 ER(er 계산 가능한 게시물만); 없으면 null
  followers: number | null;
  revenue: number | null;
  quantity: number | null;
  orders: number | null;
  aov: number | null; // 객단가 = 매출 / 주문수; 주문수 0/null이면 null
};

/**
 * R3 자동수집 notes(`[자동수집] {캡션} · 좋아요 N`)를 캡션과 좋아요로 역파싱한다.
 * - 접두어가 없으면 사용자 수동 메모로 보고 notes 원문을 캡션으로, likes=null.
 * - 접두어는 있으나 좋아요 suffix가 없으면 body 전체가 캡션, likes=null.
 * - notes가 비면 둘 다 null.
 * content-guide.ts의 toGuideReference와 동일 규약(likes만 별도로 노출).
 */
export function parsePostNote(notes: string | null | undefined): {
  caption: string | null;
  likes: number | null;
} {
  if (!notes) return { caption: null, likes: null };
  if (!notes.startsWith(AUTO_NOTE_PREFIX)) {
    return { caption: notes, likes: null };
  }
  const body = notes.slice(AUTO_NOTE_PREFIX.length);
  const m = body.match(AUTO_NOTE_LIKES_SUFFIX);
  if (!m) return { caption: body, likes: null };
  return {
    caption: body.slice(0, body.length - m[0].length),
    likes: Number(m[1]),
  };
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 콘텐츠 정체성 키 — 같은 게시물이 여러 SalesCampaign(특히 그룹 캠페인)에 등록/전파돼도
 * 하나로 합치기 위한 키. IG shortcode가 1순위(쿼리 파라미터·트래킹 꼬리가 달라도 동일 판정),
 * 없으면 externalUrl 원문, 그것도 없으면 null(=합칠 근거 없음 → 각 행을 고유로 취급).
 */
function contentIdentity(p: PerfPostInput): string | null {
  const sc = instagramShortcode(p.externalUrl);
  if (sc) return `sc:${sc}`;
  const url = p.externalUrl?.trim();
  return url ? `url:${url}` : null;
}

/** 지표 정보량 — 충돌 시 non-null 지표가 더 많은(더 최근 수집일 가능성) 행을 남긴다. */
function metricRichness(p: PerfPostInput): number {
  return (
    (finiteOrNull(p.likeCount) !== null ? 1 : 0) +
    (finiteOrNull(p.commentCount) !== null ? 1 : 0) +
    (p.thumbnailUrl ? 1 : 0)
  );
}

/**
 * 동일 콘텐츠 중복 제거(그룹 캠페인 §2 버그). 같은 contentIdentity를 가진 게시물은
 * 지표가 가장 풍부한 행 하나만 남기고, 동률이면 먼저 온 행을 유지(안정). identity가 null인
 * 행(URL 없음)은 합치지 않고 그대로 통과시킨다. 입력 순서를 보존한다(정렬은 이후 단계가 담당).
 */
export function dedupePostsByContent(posts: PerfPostInput[]): PerfPostInput[] {
  const bestByKey = new Map<string, number>(); // key → 채택된 결과 배열의 index
  const out: PerfPostInput[] = [];
  for (const p of posts) {
    const key = contentIdentity(p);
    if (key === null) {
      out.push(p);
      continue;
    }
    const existingIdx = bestByKey.get(key);
    if (existingIdx === undefined) {
      bestByKey.set(key, out.length);
      out.push(p);
    } else if (metricRichness(p) > metricRichness(out[existingIdx])) {
      out[existingIdx] = p; // 더 풍부한 지표로 교체(자리·순서는 유지)
    }
  }
  return out;
}

/** ER(%) = 좋아요 / 팔로워 × 100. likes·followers(>0) 모두 있어야 계산. */
function engagementRate(likes: number | null, followers: number | null): number | null {
  if (likes === null || followers === null || followers <= 0) return null;
  return (likes / followers) * 100;
}

/**
 * 캠페인 성과를 집계한다(stateless). posts는 미보관 셀러 게시물, ctx는 캐시 실적·팔로워.
 * 0과 null을 엄격히 구분한다(좋아요 0 = 집계됨·저조 vs null = 미집계).
 */
export function computeCampaignPerformance(
  posts: PerfPostInput[],
  ctx: CampaignPerfContext,
): CampaignPerformance {
  const followers = finiteOrNull(ctx.followers);
  const revenue = finiteOrNull(ctx.actualSales);
  const quantity = finiteOrNull(ctx.itemCount);
  const orders = finiteOrNull(ctx.orderCount);

  // 그룹 캠페인에서 동일 게시물이 여러 SalesCampaign으로 들어와 중복되는 것을 먼저 합친다(§2).
  // postCount·평균·정렬 모두 중복 제거 후 값으로 계산된다.
  const deduped = dedupePostsByContent(posts);

  const perfPosts: PerfPost[] = deduped.map((p) => {
    const { caption, likes: noteLikes } = parsePostNote(p.notes);
    // 좋아요 숨김이 최우선(임의 숫자 금지) → 구조화 likeCount → 레거시 notes 역파싱.
    const likesHidden = p.likesHidden === true;
    const likes = likesHidden ? null : finiteOrNull(p.likeCount) ?? noteLikes;
    return {
      id: p.id,
      fileName: p.fileName,
      externalUrl: p.externalUrl ?? null,
      thumbnailUrl: p.thumbnailUrl ?? null,
      caption,
      likes,
      comments: finiteOrNull(p.commentCount),
      likesHidden,
      mediaType: p.mediaType ?? null,
      er: engagementRate(likes, followers),
    };
  });

  // ER 내림차순(계산 가능한 것 우선) → 동률/미계산은 좋아요 → 댓글(숨김 게시물의 유일 지표) 내림차순. 안정 정렬.
  const sorted = perfPosts
    .map((post, index) => ({ post, index }))
    .sort((a, b) => {
      const ea = a.post.er ?? -1;
      const eb = b.post.er ?? -1;
      if (eb !== ea) return eb - ea;
      const la = a.post.likes ?? -1;
      const lb = b.post.likes ?? -1;
      if (lb !== la) return lb - la;
      const ca = a.post.comments ?? -1;
      const cb = b.post.comments ?? -1;
      if (cb !== ca) return cb - ca;
      return a.index - b.index;
    })
    .map((x) => x.post);

  const likesArr = perfPosts.map((p) => p.likes).filter((v): v is number => v !== null);
  const erArr = perfPosts.map((p) => p.er).filter((v): v is number => v !== null);

  const totalLikes = likesArr.length > 0 ? likesArr.reduce((s, v) => s + v, 0) : null;
  const avgLikes = likesArr.length > 0 ? (totalLikes as number) / likesArr.length : null;
  const avgEr = erArr.length > 0 ? erArr.reduce((s, v) => s + v, 0) / erArr.length : null;
  const aov = revenue !== null && orders !== null && orders > 0 ? revenue / orders : null;

  return {
    posts: sorted,
    postCount: perfPosts.length,
    enrichedCount: likesArr.length,
    totalLikes,
    avgLikes,
    avgEr,
    followers,
    revenue,
    quantity,
    orders,
    aov,
  };
}

// 포맷별 반응(③b 후속) — 어떤 콘텐츠 포맷(릴스/피드/캐러셀/영상)이 잘 반응했는지.
// media_type은 Asset에 없고 seller-analysis postsPreview에만 있어(shortcode 키), 라우트가
// { shortcode: media_type } 맵을 주고 여기서 계산된 게시물을 포맷별로 묶는다.
const FORMAT_LABELS: Record<string, string> = {
  reel: "릴스",
  image: "피드",
  carousel: "캐러셀",
  video: "영상",
  unknown: "기타",
};

export type FormatStat = {
  format: string; // media_type 키(reel/image/carousel/video/unknown)
  label: string; // 한글 라벨
  count: number;
  avgEr: number | null; // 계산 가능한 게시물만
  avgLikes: number | null;
};

/**
 * 계산된 게시물(PerfPost)을 media_type 포맷별로 묶어 포맷별 평균 ER·좋아요·건수를 낸다.
 * mediaTypeByShortcode: 라우트가 postsPreview에서 만든 { IG shortcode → media_type } 맵.
 * shortcode 미매칭(수동 URL·프리뷰 밖 게시물)은 'unknown'(기타)로 분류한다.
 * avgEr 내림차순 정렬(어떤 포맷이 잘 반응했는지 상단).
 */
export function aggregateErByFormat(
  posts: PerfPost[],
  mediaTypeByShortcode: Record<string, string>,
): FormatStat[] {
  const groups = new Map<string, PerfPost[]>();
  for (const p of posts) {
    // 구조화 mediaType(Asset 적재) 우선 — shortcode 맵(postsPreview)은 분석된 셀러만 커버하는 폴백
    const sc = instagramShortcode(p.externalUrl);
    const raw = p.mediaType ?? (sc ? mediaTypeByShortcode[sc] : undefined);
    const format = raw && FORMAT_LABELS[raw] ? raw : "unknown";
    const arr = groups.get(format) ?? [];
    arr.push(p);
    groups.set(format, arr);
  }
  const stats: FormatStat[] = [];
  for (const [format, arr] of groups) {
    const ers = arr.map((p) => p.er).filter((v): v is number => v !== null);
    const likes = arr.map((p) => p.likes).filter((v): v is number => v !== null);
    stats.push({
      format,
      label: FORMAT_LABELS[format] ?? "기타",
      count: arr.length,
      avgEr: ers.length > 0 ? ers.reduce((s, v) => s + v, 0) / ers.length : null,
      avgLikes: likes.length > 0 ? likes.reduce((s, v) => s + v, 0) / likes.length : null,
    });
  }
  return stats.sort((a, b) => {
    const ea = a.avgEr ?? -1;
    const eb = b.avgEr ?? -1;
    if (eb !== ea) return eb - ea;
    return b.count - a.count;
  });
}
