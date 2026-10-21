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
import { SELECTED_TOGGLE, UNSELECTED_TOGGLE } from "@/lib/selection-tone";
import { useOptimistic, useTransition } from "react";
import { classifyStory } from "@/app/admin/stories/actions";
import { toast } from "@/lib/toast";
import {
  STORY_INBOX_FILTERS,
  applyOverrides,
  classificationOfFilter,
  type StoryClassification,
  type StoryInboxCard,
  type StoryInboxFilter,
} from "@/lib/story-inbox";

type Override = { id: string; classification: StoryClassification };

export function StoryInboxGrid({
  filter,
  cards,
  counts,
  total,
  actions,
}: {
  filter: StoryInboxFilter;
  cards: StoryInboxCard[];
  counts: Record<StoryClassification, number>;
  /** 전체 탭 개수 — 서버 집계 합(분류 이동은 합을 바꾸지 않는다). */
  total: number;
  /** 탭 줄 오른쪽 끝에 서는 버튼(수집 등) — 페이지 머리를 없앤 뒤 이 줄이 본문 맨 위 도구줄이다. */
  actions?: React.ReactNode;
}) {
  const [, startTransition] = useTransition();
  const [overrides, addOverride] = useOptimistic<Record<string, StoryClassification>, Override>(
    {},
    (state, o) => ({ ...state, [o.id]: o.classification }),
  );

  const { effective, counts: shown } = applyOverrides(cards, counts, overrides);
  const want = classificationOfFilter(filter);
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
      <div data-testid="story-inbox-toolbar" className="mb-5 flex items-center justify-between gap-3">
        <nav className="flex items-center gap-1.5">
          {STORY_INBOX_FILTERS.map((tab) => {
            const count = tab.classification ? shown[tab.classification] : total;
            const active = tab.key === filter;
            return (
              <Link
                key={tab.key}
                href={`/admin/stories?f=${tab.key}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
                  active
                    ? SELECTED_TOGGLE
                    : `${UNSELECTED_TOGGLE} bg-card border border-slate-200 hover:bg-slate-50`
                }`}
              >
                {tab.label} {count}
              </Link>
            );
          })}
        </nav>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-10 text-center text-sm text-slate-500">
          {filter === "unreviewed"
            ? "분류할 스토리가 없습니다. 다음 수집(매일 00:00 KST)을 기다려주세요."
            : "해당 분류의 스토리 없음"}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {visible.map((s) => {
            const now = effective.get(s.id) ?? s.classification;
            return (
              <div key={s.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-soft-sm">
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
                          className="flex-1 rounded-md bg-status-success py-1 text-[11px] font-bold text-white hover:brightness-90"
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
