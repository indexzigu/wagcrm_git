"use client";

// 저빈도·예외 알림 카드를 한 프레임에 묶는 세그먼트 탭 컨테이너(오너 2026-07-24).
// 캐러셀과 달리 숨은 탭도 "카운트 배지"로 알림을 전달하므로, 확인 필요 N건 계열
// (데이터 점검·최저가 위반 등)을 자리 1칸에 묶어도 감시 신호가 죽지 않는다.
//
// 각 탭은 자기 내용만 render 한다(바깥 Card 는 이 컨테이너가 소유) — 그래서 소비되는
// 카드 컴포넌트는 `bare` 로 렌더해 Card 중첩(이중 테두리·그림자)을 피한다.

import { useState, useId, useRef, type ReactNode, type KeyboardEvent } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { badgeSizeClassName } from "@/components/ui/badge";

export type TabCountTone = "caution" | "urgent" | "success" | "info" | "neutral";

const TONE_BADGE: Record<TabCountTone, string> = {
  // 전부 @theme 노출 유틸로 통일(ss-ux 지적) — caution 만 화살괄호 문법이던 것 수렴.
  caution: "bg-status-caution-bg text-status-caution-text",
  urgent: "bg-status-urgent-bg text-status-urgent-text",
  success: "bg-status-success-bg text-status-success",
  info: "bg-status-info/10 text-status-info",
  neutral: "bg-slate-100 text-slate-500",
};

export interface TabMeta {
  key: string;
  label: string;
  count?: number;
  countTone?: TabCountTone;
}

export interface SegmentedTab extends TabMeta {
  render: () => ReactNode;
}

// 밑줄형 세그먼트 탭 바(controlled) — SegmentedTabCard 와 "오늘의 핵심 업무"처럼 Card 헤더를
// 따로 둔 소비처가 공유한다. 비활성 탭도 카운트 배지를 유지(숨은 알림)하고, APG 키보드 내비
// (방향키·roving tabindex)·aria 연결을 담당한다. 패널은 호출자가 role="tabpanel"로 렌더한다.
export function SegmentedTabBar({
  tabs,
  active,
  onSelect,
  idPrefix,
  className,
}: {
  tabs: TabMeta[];
  active: string;
  onSelect: (key: string) => void;
  idPrefix: string;
  className?: string;
}) {
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.key === active);
    if (idx < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next].key;
    onSelect(key);
    btnRefs.current[key]?.focus();
  };

  return (
    <div role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown} className={`flex items-center gap-1 border-b border-slate-100 ${className ?? ""}`}>
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        const tone = tab.countTone ?? "neutral";
        return (
          <button
            key={tab.key}
            ref={(el) => { btnRefs.current[tab.key] = el; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-selected={isActive}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            className={`group relative flex items-center gap-1.5 px-2 pb-2 pt-0.5 text-sm font-bold tracking-tight transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none ${
              isActive ? "text-[var(--primary)]" : "text-muted-foreground/60 hover:text-muted-foreground"
            }`}
          >
            <span>{tab.label}</span>
            {tab.count != null && tab.count > 0 && (
              <span className={`inline-flex items-center justify-center ${badgeSizeClassName.count} ${TONE_BADGE[tone]}`}>
                {tab.count}
              </span>
            )}
            {/* 활성 밑줄 — 헤더 하단 경계선 위에 겹쳐 그린다 */}
            <span
              aria-hidden
              className={`absolute -bottom-px left-0 right-0 h-0.5 rounded-full transition-opacity ${
                isActive ? "bg-[var(--primary)] opacity-100" : "opacity-0"
              }`}
            />
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedTabCard({
  tabs,
  defaultTabKey,
  className,
  bodyClassName,
}: {
  tabs: SegmentedTab[];
  defaultTabKey?: string;
  className?: string;
  // 활성 패널 컨테이너 클래스 오버라이드. 기본은 flex-1(콘텐츠에 맞춰 늘어남). 트라이어드처럼
  // 카드 높이가 형제 칸에 묶여 있고 탭마다 콘텐츠 양이 다른 경우, 고정 높이(h-[Npx])를 넘겨
  // 두 탭이 동일 높이가 되게 하면 탭 전환·데이터 증감에도 카드 높이가 흔들리지 않는다(ss-ux P0).
  bodyClassName?: string;
}) {
  const [active, setActive] = useState(defaultTabKey ?? tabs[0]?.key);
  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];
  const uid = useId();

  return (
    <Card className={`border-black/5 bg-white/85 shadow-soft-sm h-full flex flex-col ${className ?? ""}`}>
      <CardContent className="px-4 py-3 flex flex-col flex-1 min-h-0">
        <SegmentedTabBar tabs={tabs} active={active ?? ""} onSelect={setActive} idPrefix={uid} />
        {/* 활성 패널 — bodyClassName 로 높이 정책을 주입(기본 flex-1) */}
        <div
          role="tabpanel"
          id={activeTab ? `${uid}-panel-${activeTab.key}` : undefined}
          aria-labelledby={activeTab ? `${uid}-tab-${activeTab.key}` : undefined}
          className={bodyClassName ?? "mt-3 flex flex-1 flex-col min-h-0"}
        >
          {activeTab?.render()}
        </div>
      </CardContent>
    </Card>
  );
}
