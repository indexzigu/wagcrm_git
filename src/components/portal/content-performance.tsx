// 내 콘텐츠 성과 — 캠페인 기간 중 수집된 셀러 게시물 "전체" 리스트 (포털 공용).
// 오너 결정(2026-07-11): ① 베스트 1건이 아니라 전체 게시물 노출 ② 게시물별 좋아요·댓글 수 표기
// ③ 좋아요를 숨긴 게시물은 임의 숫자 없이 "비공개"로 표기(3-state의 숨김 상태).
// 표기 규약의 SSOT는 postMetricsLine — content-performance.contract.test.tsx가 회귀를 강제한다.
// 서버 컴포넌트(무JS) — 긴 리스트는 구성별 판매와 동일한 네이티브 <details> 접기.
import { ArrowUpRight, ChevronDown, Layers, Play } from "lucide-react";
import type { CampaignPerformance, PerfPost } from "@/lib/campaign-performance-report";

/** 썸네일 우상단 유형 배지 — 릴스/영상=Play, 캐러셀=Layers(오너 아젠다: 게시물 유형 즉시 식별).
 *  44px 썸네일이라 텍스트 없이 글리프만, asset-manager PostThumb의 유형 배지와 의미 규약 공유. */
function MediaTypeBadge({ mediaType }: { mediaType: string | null }) {
  const isVideo = mediaType === "reel" || mediaType === "video";
  if (!isVideo && mediaType !== "carousel") return null;
  const Icon = isVideo ? Play : Layers;
  const label = isVideo ? (mediaType === "reel" ? "릴스" : "영상") : "캐러셀";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="absolute right-0.5 top-0.5 inline-flex items-center justify-center rounded bg-black/55 p-0.5 backdrop-blur-sm"
    >
      <Icon className={`size-2.5 text-white ${isVideo ? "fill-white" : ""}`} />
    </span>
  );
}

/** 접기 없이 상시 노출할 게시물 수 — 나머지는 <details>로 접힌다. */
const VISIBLE_COUNT = 3;

/**
 * 게시물 1건의 지표 라인 표기 규약(SSOT).
 * - 좋아요: 숨김이면 "좋아요 비공개"(숫자 금지) · 집계값이면 "좋아요 N" · 미집계면 생략
 * - 댓글: 집계됐을 때만 "댓글 N"
 * - ER: 계산 가능할 때만 "ER x.x%"
 * - 셋 다 없으면 "집계 전"
 */
export function postMetricsLine(post: PerfPost): string {
  const parts: string[] = [];
  if (post.likesHidden) {
    parts.push("좋아요 비공개");
  } else if (post.likes !== null) {
    parts.push(`좋아요 ${post.likes.toLocaleString()}`);
  }
  if (post.comments !== null) parts.push(`댓글 ${post.comments.toLocaleString()}`);
  if (post.er !== null) parts.push(`ER ${post.er.toFixed(1)}%`);
  return parts.length > 0 ? parts.join(" · ") : "집계 전";
}

function PostRow({ post, best }: { post: PerfPost; best: boolean }) {
  const body = (
    <>
      <div className="relative h-11 w-11 shrink-0">
        {post.thumbnailUrl ? (
          // 접힌 <details> 안에서도 <img>는 즉시 fetch되므로 lazy 필수(모바일 데이터 보호)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-11 w-11 rounded-xl object-cover"
          />
        ) : (
          <div aria-hidden="true" className="h-11 w-11 rounded-xl bg-slate-100" />
        )}
        <MediaTypeBadge mediaType={post.mediaType} />
      </div>
      <div className="min-w-0 flex-1">
        {best && (
          // 라벨(숫자 아님) → info, PALETTE_IMPL_SPEC.md 인디고 분류 2026-07-09
          <div className="text-[10px] font-bold text-status-info uppercase">베스트 게시물</div>
        )}
        {post.caption && <div className="text-[11px] text-slate-500 truncate">{post.caption}</div>}
        <div className="text-xs text-slate-600 mt-0.5">{postMetricsLine(post)}</div>
      </div>
      {/* 새 탭 외부 이동 사전 신호(ss 검토) — 링크 행에만 */}
      {post.externalUrl && <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />}
    </>
  );
  // 원본 게시물로 새 탭 링크(있을 때만) — 셀러가 어느 게시물인지 바로 확인하는 동선
  return post.externalUrl ? (
    <a
      href={post.externalUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 -mx-1 px-1 py-0.5 rounded-lg hover:bg-slate-50 transition-colors"
    >
      {body}
    </a>
  ) : (
    <div className="flex items-center gap-3 px-0 py-0.5">{body}</div>
  );
}

/** 진행 캠페인 카드의 "내 콘텐츠 성과" 섹션 — postCount>0일 때만 부모가 렌더한다. */
export function ContentPerformanceSection({ contentPerf }: { contentPerf: CampaignPerformance }) {
  const posts = contentPerf.posts;
  if (posts.length === 0) return null;
  const visible = posts.slice(0, VISIBLE_COUNT);
  const folded = posts.slice(VISIBLE_COUNT);
  // "베스트" 라벨은 비교가 성립할 때만(2건+ & 선두가 ER 계산 가능) — 1건뿐이면 라벨이 무의미
  const markBest = posts.length > 1 && posts[0].er !== null;

  return (
    <div className="px-5 py-4 border-b border-slate-100">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-xs font-bold text-slate-500">내 콘텐츠 성과</h3>
        <span className="text-[11px] text-slate-500 text-right">
          게시물 {contentPerf.postCount}건
          {contentPerf.avgEr !== null && <> · 평균 ER {contentPerf.avgEr.toFixed(1)}%</>}
        </span>
      </div>
      <div className="space-y-2.5">
        {visible.map((p, i) => (
          <PostRow key={p.id} post={p} best={markBest && i === 0} />
        ))}
      </div>
      {/* 좋아요 숨김 게시물이 실제로 있을 때만 원인 각주 — "집계 오류" 오해로 인한 CS 문의 방지(ss 검토 High-2) */}
      {posts.some((p) => p.likesHidden) && (
        <p className="text-[10px] text-slate-500 mt-2">
          인스타그램에서 좋아요 수를 숨긴 게시물은 &lsquo;비공개&rsquo;로 표시돼요
        </p>
      )}
      {folded.length > 0 && (
        <details className="group mt-2.5">
          <summary className="list-none [&::-webkit-details-marker]:hidden marker:hidden flex items-center justify-between gap-1.5 cursor-pointer -mx-1 px-1 py-1.5 rounded-md text-[11px] font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors">
            <span>나머지 {folded.length}건 보기</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 pt-2 border-t border-slate-50 space-y-2.5">
            {folded.map((p) => (
              <PostRow key={p.id} post={p} best={false} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
