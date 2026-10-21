// 스토리 분류함(/admin/stories)의 탭·분류 정의와 낙관적 개수 계산.
//
// ⛔ 이 정의를 `story-inbox-grid.tsx`("use client")로 되돌리지 말 것 — 클라이언트 모듈에서 내보낸 값을
// 서버 페이지가 가져오면 실제 값이 아니라 클라이언트 참조가 와서 `.find is not a function` 으로 죽는다
// (2026-10-21 실렌더에서 발견, 타입체크·단위 테스트는 통과했다). 서버 페이지와 그리드가 함께 쓰는 것은 여기.

export type StoryClassification = "UNREVIEWED" | "CAMPAIGN" | "OTHER";
export type StoryInboxFilter = "unreviewed" | "campaign" | "other" | "all";

export type StoryInboxCard = {
  id: string;
  displayName: string;
  img: string | null;
  isVideo: boolean;
  /** 리호스팅 썸네일이 없어 인스타 원본 이미지 주소만 있다 — 원본 주소는 만료될 수 있다. */
  sourceUrlOnly: boolean;
  takenAtLabel: string;
  snsHandle: string;
  classification: StoryClassification;
};

export const STORY_INBOX_FILTERS: { key: StoryInboxFilter; label: string; classification?: StoryClassification }[] = [
  { key: "unreviewed", label: "미분류", classification: "UNREVIEWED" },
  { key: "campaign", label: "캠페인 홍보", classification: "CAMPAIGN" },
  { key: "other", label: "무관", classification: "OTHER" },
  { key: "all", label: "전체" },
];

/** 주소의 `?f=` 로 받을 수 있는 탭 — 탭 정의(FILTERS) 한 곳에서 파생한다. */
export const STORY_INBOX_FILTER_KEYS: readonly StoryInboxFilter[] = STORY_INBOX_FILTERS.map((f) => f.key);

/** 탭이 보여 주는 분류(전체 탭은 undefined). 페이지의 DB 조건도 이것으로 만든다. */
export function classificationOfFilter(filter: StoryInboxFilter): StoryClassification | undefined {
  return STORY_INBOX_FILTERS.find((f) => f.key === filter)?.classification;
}

/** DB 저장값(String)을 분류로 좁힌다 — 3종 밖 값은 null(호출자가 판단). */
export function toStoryClassification(value: string): StoryClassification | null {
  return value === "UNREVIEWED" || value === "CAMPAIGN" || value === "OTHER" ? value : null;
}

/**
 * 낙관적 덮어쓰기를 반영한 카드별 분류와 탭 개수. 개수는 서버 집계(`counts`)에 "원래 분류 → 새 분류"
 * 이동분만 더한다 — 지금 화면에 없는 카드(200장 밖)의 개수는 서버 값 그대로다.
 */
export function applyOverrides(
  cards: StoryInboxCard[],
  counts: Record<StoryClassification, number>,
  overrides: Record<string, StoryClassification>,
) {
  const next = { ...counts };
  const effective = new Map<string, StoryClassification>();
  for (const card of cards) {
    const now = overrides[card.id] ?? card.classification;
    effective.set(card.id, now);
    if (now !== card.classification) {
      next[card.classification] -= 1;
      next[now] += 1;
    }
  }
  return { effective, counts: next };
}
