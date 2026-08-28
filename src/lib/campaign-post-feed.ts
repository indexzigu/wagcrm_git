// campaign-post-feed — 캠페인 상세 "셀러 게시물"의 통합 피드 view-model 빌더(순수).
// 오너 결정(2026-07-12): 추천(후보)과 등록 게시물을 별개 그리드로 나눌 이유가 수집시각 구분
// 외엔 없다 → 하나의 목록·같은 카드 포맷으로 통합. 상태 차이(후보=미확정 / 등록=확정)는
// 카드 내 액션·시각 상태로만 표현하고, 목록·정렬은 하나로 합친다.
//
// 정렬: 게시시각(postedAt) 내림차순 = 최신순. ER은 정렬키가 아니라 카드 메타로만 유지한다
// (오너 의도 "같은 목록 관리" — 후보를 상단 고정하면 다시 두 그룹으로 쪼개지는 셈이라 안 함).
// Prisma·HTTP 비의존 — asset-manager가 이미 로드한 데이터로 계산한다.
import type { AssetRow } from "./crm-types";
import type { PerfPost } from "./campaign-performance-report";
import type { SuggestedPost } from "./campaign-suggested-posts";
import { postIdentityKey } from "./reference-url";

/** dedupe 입력의 최소 형태 — 셀러 게시물 asset의 부분집합(테스트 주입 용이). */
type DedupableAsset = { id: string; externalUrl?: string | null; entityId: string };

/**
 * 그룹(조합) 캠페인은 같은 셀러 게시물이 여러 회차에 각각 등록될 수 있다(오너 실측: 한 URL 3회차).
 * 공유 피드가 이를 그대로 펼치면 중복 카드·성과 double-count가 생기므로, 게시물 신원 키
 * (postIdentityKey — IG는 shortcode라 `/p/`·`/reel/` 형태가 갈려도 동일 판정) 기준으로 대표
 * 1장만 남긴다. 대표는 현재 캠페인 소속 asset을 우선(복사·임베드가 현재 맥락에서 동작). 순수 함수.
 * - deduped: 신원 키별 대표 asset 배열(입력 순서 유지 — Map 삽입 순서, 대표 교체 시 위치 보존).
 * - byPermalink: 신원 키 → 그 게시물의 전 회차 asset[](제외 시 모두 함께 보관하기 위한 역인덱스).
 *   소비처는 조회 키도 postIdentityKey로 만들어야 한다(asset-manager 제외 플로우).
 * URL이 없거나 파싱 실패한 asset은 id를 키로 고유 취급(중복 아님)하며 byPermalink엔 넣지 않는다.
 */
export function dedupeSellerPostsByUrl<T extends DedupableAsset>(
  posts: T[],
  currentCampaignId: string,
): { deduped: T[]; byPermalink: Map<string, T[]> } {
  const byKey = new Map<string, T>();
  const byPermalink = new Map<string, T[]>();
  for (const a of posts) {
    const norm = a.externalUrl ? postIdentityKey(a.externalUrl) : null;
    const key = norm || a.id;
    const existing = byKey.get(key);
    // 대표 선택: 없으면 채택, 있으면 현재 캠페인 소속일 때만 교체(위치는 유지).
    if (!existing) byKey.set(key, a);
    else if (a.entityId === currentCampaignId && existing.entityId !== currentCampaignId) {
      byKey.set(key, a);
    }
    if (norm) {
      const arr = byPermalink.get(norm);
      if (arr) arr.push(a);
      else byPermalink.set(norm, [a]);
    }
  }
  return { deduped: [...byKey.values()], byPermalink };
}

/** 통합 피드의 한 장. status로 후보/등록을 구분(discriminated union)하고 원본 참조를 실어 나른다. */
export type SellerFeedCard =
  | {
      status: "candidate";
      /** React key 겸 인스타 임베드 토글 키(추천은 permalink로 식별). */
      key: string;
      /** 정렬 키(게시시각 epoch, 없으면 0 → 뒤로). 표시는 suggestion.takenAt을 쓴다. */
      sortEpoch: number;
      suggestion: SuggestedPost;
    }
  | {
      status: "registered";
      /** React key 겸 임베드 토글 키(등록은 asset.id = PerfPost.id로 식별). */
      key: string;
      sortEpoch: number;
      post: PerfPost;
      asset: AssetRow;
    };

function epochOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 후보(추천)와 등록 게시물을 하나의 피드로 병합해 최신순(게시시각 내림차순)으로 정렬한다.
 * - 후보 게시시각 = suggestion.takenAt.
 * - 등록 게시시각 = asset.postedAt(실제 IG 게시시각) ?? asset.createdAt(수동 추가 폴백).
 *   createdAt은 AssetRow에 항상 있으므로 등록 카드는 언제나 정렬 가능한 시각을 갖는다.
 * - 동률·미상(epoch 0)은 입력 순서를 유지한다(안정 정렬: 후보 먼저, 그 안에서 원래 순서).
 */
export function mergeSellerPostFeed(
  candidates: SuggestedPost[],
  registered: { post: PerfPost; asset: AssetRow }[],
): SellerFeedCard[] {
  const cards: SellerFeedCard[] = [
    ...candidates.map(
      (s): SellerFeedCard => ({
        status: "candidate",
        key: `candidate:${s.permalink}`,
        sortEpoch: epochOf(s.takenAt),
        suggestion: s,
      }),
    ),
    ...registered.map(
      ({ post, asset }): SellerFeedCard => ({
        status: "registered",
        key: `registered:${post.id}`,
        sortEpoch: epochOf(asset.postedAt ?? asset.createdAt),
        post,
        asset,
      }),
    ),
  ];

  // 안정 정렬(입력 인덱스를 tiebreak로) — 동률·미상 게시물의 순서를 결정론적으로 유지한다.
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => b.card.sortEpoch - a.card.sortEpoch || a.index - b.index)
    .map((x) => x.card);
}
