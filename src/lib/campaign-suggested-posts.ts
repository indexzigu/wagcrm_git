// campaign-suggested-posts — R5/R6 후속(후보②): seller-analysis가 이미 수집한 셀러 피드
// (SellerAiProfile.aiTags.postsPreview)에서 캠페인 기간 안에 셀러가 올린 게시물을 "후보"로 제시하는 순수 로직.
// 목적: R5 셀러 게시물 등록의 수동 URL 붙여넣기를 대체 — 후보를 한 클릭 홍보(등록)로 줄인다.
//
// ⚠️ 완전 자동 아님(R5 스펙 결정2: 담당자가 "이 게시물이 이 캠페인 홍보"를 최종 판정).
// 개편(오너 2026-07-13): 스토리와 동일 모델(전량 노출 후 분류)로 통일한다.
//   - is_gongu(공구 감지)는 더 이상 후보 "필터"가 아니다 — 릴스 등 짧은 캡션이 걸러지던 문제를 해소.
//     대신 자동 "홍보 추천" 신호(recommended)로만 쓴다(담당자 원클릭 등록 유도).
//   - 후보 범위 = 기간창(시작−lead ~ 마감+trail) ∩ permalink 존재 ∩ 미등록(Asset) ∩ 무관(OTHER) 아님.
//   - "홍보 확정"은 이 후보를 Asset(EXTERNAL_LINK)으로 등록하는 것(성과추적) — 그 순간 후보에서 빠진다.
//   - "무관"은 SellerPostClassification(OTHER)로 영구 숨김 — dismissedUrls로 주입받아 제외한다.
// 신규 수집·의존성 0 — 이미 영속된 postsPreview + 분류 테이블로 계산한다.
import { normalizeReferenceUrl, postIdentityKey } from "./reference-url";

/** postsPreview 항목 중 후보 판정에 필요한 최소 형태(seller-analysis PostPreview 부분집합). */
export type SuggestablePost = {
  permalink?: string | null;
  taken_at?: string | null; // ISO 문자열
  likes?: number | null;
  /** 좋아요 숨김 계정 신호 — true면 likes=0은 센티널이라 "비공개"로 표기(임의 숫자 금지). */
  likes_hidden?: boolean | null;
  comments?: number | null;
  thumb?: string | null;
  media_type?: string | null;
  is_gongu?: boolean | null;
  video_url?: string | null;
};

export type SuggestedPost = {
  permalink: string; // 정규화된 URL — 등록 시 externalUrl로 사용
  takenAt: string | null;
  likes: number;
  /** 좋아요 숨김이면 true — UI가 likes 대신 "비공개" 표기. 등록 게시물 카드와 동일 3-state 계약. */
  likesHidden: boolean;
  comments: number | null; // 집계 전이면 null
  thumb: string | null;
  mediaType: string | null;
  videoUrl: string | null;
  /** 공구 자동감지(is_gongu) 파생 — true면 UI가 "홍보 추천"으로 강조·우선 정렬(자동 등록 아님, 원클릭 유도).
   *  DB에 저장하지 않는 순수 파생값이다(GET 부작용 없음 계약 유지). */
  recommended: boolean;
};

export type SuggestOptions = {
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  /** 이미 이 캠페인에 등록된 게시물 URL들(정규화 전 원본도 허용 — 내부에서 정규화). */
  registeredUrls?: Iterable<string>;
  /** "무관(OTHER)"으로 분류돼 영구 숨김할 게시물 URL들(SellerPostClassification). 내부에서 정규화. */
  dismissedUrls?: Iterable<string>;
  /** 캠페인 시작 이전 며칠까지 후보로 볼지(티저 게시물). 기본 7. */
  leadDays?: number;
  /** 캠페인 종료 이후 며칠까지 후보로 볼지. 기본 1(스토리 수집창과 통일 — 마감 +1일, 오너 2026-07-11). */
  trailDays?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toEpoch(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * 캠페인 기간 안에 셀러가 올린 게시물 후보를 추린다(전량 노출 후 분류 모델, 오너 2026-07-13).
 * 규칙: ① permalink 존재 ② 아직 캠페인에 미등록(Asset=홍보 확정) ③ 무관(OTHER)으로 분류되지 않음
 *       ④ 기간 창 [시작−leadDays, 종료+trailDays] 내(창을 계산할 수 있을 때).
 *       is_gongu는 제외 조건이 아니라 recommended(자동 홍보 추천) 신호로만 파생한다.
 * 정렬: 최신순(게시시각 내림차순, 미상·동률은 원래 순서 유지 — 안정 정렬). 캡션 미보유라 상품명 매칭은 하지 않는다.
 */
export function suggestCampaignPosts(
  posts: SuggestablePost[],
  opts: SuggestOptions = {},
): SuggestedPost[] {
  const start = toEpoch(opts.startDate);
  const end = toEpoch(opts.endDate);
  const lead = (opts.leadDays ?? 7) * DAY_MS;
  const trail = (opts.trailDays ?? 1) * DAY_MS;
  // 창은 시작·종료가 하나라도 있으면 구성(한쪽만 있으면 그 경계만 적용).
  const lo = start !== null ? start - lead : null;
  const hi = end !== null ? end + trail : start !== null ? start + trail : null;

  // 대조 키는 shortcode 신원(postIdentityKey) — 프리뷰는 릴스도 `/p/{sc}/`로 저장하는데
  // 수동 등록은 `/reel/{sc}/` 원형이 들어와, URL 문자열 대조로는 같은 게시물이 등록 카드와
  // 후보 카드에 동시에 뜬다(중복 노출 갭).
  const registered = new Set<string>();
  for (const u of opts.registeredUrls ?? []) {
    const k = postIdentityKey(u);
    if (k) registered.add(k);
  }
  const dismissed = new Set<string>();
  for (const u of opts.dismissedUrls ?? []) {
    const k = postIdentityKey(u);
    if (k) dismissed.add(k);
  }

  const out: { post: SuggestedPost; index: number }[] = [];
  posts.forEach((p, index) => {
    const norm = p.permalink ? normalizeReferenceUrl(p.permalink) : null;
    if (!norm) return;
    const identity = postIdentityKey(norm) ?? norm;
    if (registered.has(identity)) return; // 등록(홍보 확정) = 통합 피드의 registered 카드로 이미 노출
    if (dismissed.has(identity)) return; // 무관(OTHER) = 영구 숨김(오너 결정4)
    // 기간 창이 있으면 taken_at이 창 안이어야 한다. taken_at이 없으면 창 판정 불가 → 창이 있을 땐 제외.
    if (lo !== null || hi !== null) {
      const t = toEpoch(p.taken_at);
      if (t === null) return;
      if (lo !== null && t < lo) return;
      if (hi !== null && t > hi) return;
    }
    out.push({
      post: {
        permalink: norm,
        takenAt: p.taken_at ?? null,
        likes: typeof p.likes === "number" && Number.isFinite(p.likes) ? p.likes : 0,
        likesHidden: p.likes_hidden === true,
        comments:
          typeof p.comments === "number" && Number.isFinite(p.comments) ? p.comments : null,
        thumb: p.thumb ?? null,
        mediaType: p.media_type ?? null,
        videoUrl: p.video_url ?? null,
        // 공구 자동감지 → 자동 홍보 추천(강조·우선 정렬용 파생 신호, 저장 안 함).
        recommended: p.is_gongu === true,
      },
      index,
    });
  });

  // 최신순(게시시각 내림차순). takenAt이 이미 창 필터를 통과했으므로 대개 존재하지만,
  // 창이 없어 통과한 미상(null)은 뒤로 보내고 동률·미상은 원래 순서 유지(안정 정렬).
  return out
    .sort((a, b) => {
      const ta = a.post.takenAt ? Date.parse(a.post.takenAt) : 0;
      const tb = b.post.takenAt ? Date.parse(b.post.takenAt) : 0;
      if (tb !== ta) return tb - ta;
      return a.index - b.index;
    })
    .map((x) => x.post);
}
