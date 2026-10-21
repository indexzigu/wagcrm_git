"use client";

// 스토리 분류함의 탭 개수 + 카드 그리드 — /admin/stories 전용.
//
// 분류 버튼은 **누르는 즉시** 결과를 보여 준다(useOptimistic): 카드가 지금 탭에서 빠지고 탭 개수가
// 바뀐다. 저장(서버 액션)과 페이지 재계산은 그 뒤에서 진행된다. 예전에는 서버 왕복 + 페이지 전체
// 재렌더가 끝날 때까지 화면이 그대로라, 저장은 됐는데 "안 눌렸다"로 보였다(2026-10-21 오너 제보 —
// DB 에는 저장돼 있었다). 실패하면 낙관적 상태가 자동으로 원래대로 돌아오고 오류 알림을 띄운다
// (P0 무음 실패 금지). 성공 알림은 두지 않는다 — 카드가 빠지고 개수가 바뀌는 것이 곧 신호다(P2 Toast
// Ownership, ss-ux 검토 2026-10-21).
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { classifyStory } from "@/app/admin/stories/actions";
import { toast } from "@/lib/toast";

export type StoryClassification = "UNREVIEWED" | "CAMPAIGN" | "OTHER";
export type StoryInboxFilter = "unreviewed" | "campaign" | "other" | "all";

export type StoryInboxCard = {
  id: string;
  displayName: string;
  img: string | null;
  isVideo: boolean;
  sourceUrlOnly: boolean;
  takenAtLabel: string;
  snsHandle: string;
  classification: StoryClassification;
};

const FILTERS: { key: StoryInboxFilter; label: string; classification?: StoryClassification }[] = [
  { key: "unreviewed", label: "미분류", classification: "UNREVIEWED" },
  { key: "campaign", label: "캠페인 홍보", classification: "CAMPAIGN" },
  { key: "other", label: "무관", classification: "OTHER" },
  { key: "all", label: "전체" },
];

type Override = { id: string; classification: StoryClassification };

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
      // 저장값은 DB 상 String 이라 3종 밖 값이 올 수 있다 — 그 칸은 0 에서 시작해 NaN 을 막는다.
      next[card.classification] = (next[card.classification] ?? 0) - 1;
      next[now] = (next[now] ?? 0) + 1;
    }
  }
  return { effective, counts: next };
}

export function StoryInboxGrid({
  filter,
  cards,
  counts,
  total,
}: {
  filter: StoryInboxFilter;
  cards: StoryInboxCard[];
  counts: Record<StoryClassification, number>;
  /** 전체 탭 개수 — 서버 집계 합(분류 이동은 합을 바꾸지 않는다). */
  total: number;
}) {
  const [, startTransition] = useTransition();
  const [overrides, addOverride] = useOptimistic<Record<string, StoryClassification>, Override>(
    {},
    (state, o) => ({ ...state, [o.id]: o.classification }),
  );

  const { effective, counts: shown } = applyOverrides(cards, counts, overrides);
  const want = FILTERS.find((f) => f.key === filter)?.classification;
  const visible = cards.filter((c) => !want || effective.get(c.id) === want);

  function classify(id: string, displayName: string, classification: StoryClassification) {
    startTransition(async () => {
      addOverride({ id, classification });
      try {
        await classifyStory(id, classification);
      } catch (error) {
        console.error("[story-inbox] classify failed", error);
        // 「되돌렸다」고 말하지 않는다 — 다른 저장이 진행 중이면 그것들이 끝날 때까지 원복이 늦다.
        toast.error(`${displayName} 스토리의 분류를 저장하지 못했습니다. 다시 눌러 주세요.`);
      }
    });
  }

  return (
    <>
      <nav className="mb-5 flex items-center gap-1.5">
        {FILTERS.map((tab) => {
          const count = tab.classification ? shown[tab.classification] : total;
          const active = tab.key === filter;
          return (
            <Link
              key={tab.key}
              href={`/admin/stories?f=${tab.key}`}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {tab.label} {count}
            </Link>
          );
        })}
      </nav>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          {filter === "unreviewed"
            ? "분류할 스토리가 없습니다. 다음 수집(매일 00:00 KST)을 기다려주세요."
            : "해당 분류의 스토리 없음"}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {visible.map((s) => {
            const now = effective.get(s.id) ?? s.classification;
            return (
              <div key={s.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-soft-sm">
                <div className="relative aspect-[9/16] bg-slate-100">
                  {s.img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.img} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                      썸네일 없음
                    </div>
                  )}
                  {s.isVideo && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      영상
                    </span>
                  )}
                  {s.sourceUrlOnly && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-status-caution px-1.5 py-0.5 text-[10px] font-bold text-white">
                      원본 URL(만료 가능)
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <div className="truncate text-xs font-semibold text-slate-800">{s.displayName}</div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {s.takenAtLabel} · @{s.snsHandle}
                  </div>
                  <div className="mt-2 flex gap-1">
                    {now === "UNREVIEWED" ? (
                      <>
                        <button
                          type="button"
                          onClick={() => classify(s.id, s.displayName, "CAMPAIGN")}
                          className="flex-1 rounded-md bg-status-success py-1 text-[11px] font-bold text-white hover:bg-emerald-800"
                        >
                          캠페인
                        </button>
                        <button
                          type="button"
                          onClick={() => classify(s.id, s.displayName, "OTHER")}
                          className="flex-1 rounded-md bg-slate-200 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-300"
                        >
                          무관
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => classify(s.id, s.displayName, "UNREVIEWED")}
                        className="flex-1 rounded-md border border-slate-200 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
                      >
                        {now === "CAMPAIGN" ? "✓ 캠페인 홍보" : "무관"} (되돌리기)
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
