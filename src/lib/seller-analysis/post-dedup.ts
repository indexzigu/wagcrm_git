// 재업로드 사본 접기(콘텐츠 레벨 near-duplicate) — 순수 함수 모듈, 외부 의존성 없음.
//
// 배경: 셀러가 같은 콘텐츠를 지웠다 올리거나 피드 비노출 방식(트라이얼 릴스류)으로 다시 올리면
// shortcode가 다른 별개 게시물 2건으로 수집된다. shortcode 신원 키로는 원리적으로 못 잡는
// 중복이라, 지표 계산 직전에 "같은 콘텐츠 클러스터당 대표 1건"으로 접는다.
// 수집·저장·postsPreview는 원본을 그대로 유지한다 — 접기는 집계(metrics)와 유료 댓글 수집
// 타깃 선정에만 적용한다(원천 필터링은 비재현적이고 재업로드 행동 신호를 소실시킨다).
//
// 접힘 조건(셋 다 충족해야 접힘 — 오접힘보다 미접힘이 안전하다는 보수 원칙):
//   ① 정규화 캡션이 완전 동일(비어있지 않아야 함 — 캡션 없는 릴스는 지문이 없어 접지 않음)
//   ② media_type 동일 (같은 콘텐츠를 이미지+릴스로 교차 게시하는 건 별개 발행으로 본다)
//   ③ 게시 시각이 인접(기본 72h 체인) — 같은 캡션을 매주 복붙하는 공구 시리즈(주기 ≥7일)를
//      오접힘하지 않도록 주간 주기보다 충분히 좁게 잡는다. taken_at 없는 게시물은 근접을
//      검증할 수 없으므로 접지 않는다.
// 대표 선정: 좋아요+댓글 합이 최대인 변형(피드에 살아남은 쪽의 실용적 근사) — 동점이면 이른 게시물.

import { RawPost } from './types';

/** 재업로드 판정 시간창(시간). 관찰된 재업로드는 전부 당일~익일 — 주간 시리즈(168h)와 안전 격리 */
export const REPOST_WINDOW_HOURS = 72;

/**
 * 캡션을 dedup 지문으로 정규화 — NFC 통일(한글 NFD 함정), zero-width 제거, 공백 접기, 소문자.
 * 빈 결과('')는 "지문 없음"을 뜻하며 호출부는 접기 대상에서 제외해야 한다.
 */
export function normalizeCaptionKey(caption: string | null | undefined): string {
  if (!caption) return '';
  return caption
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 재업로드 사본을 대표 1건으로 접은 배열을 반환한다. 대표들은 입력 순서를 보존한다.
 * 입력 배열은 변경하지 않는다.
 */
export function collapseRepostDuplicates(
  posts: RawPost[],
  windowHours: number = REPOST_WINDOW_HOURS
): RawPost[] {
  if (posts.length < 2) return posts;
  const windowMs = windowHours * 60 * 60 * 1000;

  type Entry = { post: RawPost; index: number; time: number };
  const groups = new Map<string, Entry[]>();
  const keep = new Set<number>();

  posts.forEach((post, index) => {
    const key = normalizeCaptionKey(post.caption);
    const time = post.taken_at ? new Date(post.taken_at).getTime() : NaN;
    if (!key || !isFinite(time)) {
      keep.add(index); // 지문·시각 없음 → 접기 불가, 항상 통과
      return;
    }
    // 캡션에 개행이 남지 않으므로(공백 접기) '\n'은 안전한 구분자다
    const groupKey = `${post.media_type || 'unknown'}\n${key}`;
    const entries = groups.get(groupKey) ?? [];
    entries.push({ post, index, time });
    groups.set(groupKey, entries);
  });

  for (const entries of groups.values()) {
    entries.sort((a, b) => a.time - b.time || a.index - b.index);
    let cluster: Entry[] = [];
    const flushCluster = () => {
      if (cluster.length === 0) return;
      let rep = cluster[0];
      for (const e of cluster) {
        const eng = (e.post.likes || 0) + (e.post.comments_count || 0);
        const repEng = (rep.post.likes || 0) + (rep.post.comments_count || 0);
        if (eng > repEng) rep = e; // 동점이면 이른 게시물(rep) 유지
      }
      keep.add(rep.index);
    };
    for (const entry of entries) {
      // 직전 클러스터 멤버와의 간격으로 체인 — 연쇄 재업로드(0h→48h→96h)도 한 클러스터
      if (cluster.length > 0 && entry.time - cluster[cluster.length - 1].time <= windowMs) {
        cluster.push(entry);
      } else {
        flushCluster();
        cluster = [entry];
      }
    }
    flushCluster();
  }

  return posts.filter((_, i) => keep.has(i));
}
