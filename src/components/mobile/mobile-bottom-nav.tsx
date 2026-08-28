"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDaysIcon, HomeIcon, Table2Icon } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { useWebAppEnvironment } from "@/hooks/use-web-app-environment";

// v3.2(소유자 피드백 C): 영업 탭 제거 — /outreach 라우트는 존치, "업무 처리" 탭의
// 리마인드 지연 행에서 딥링크로만 진입한다.
// 2026-07-15 오너 피드백: 탭 순서 홈 → 일정 → 캠페인 (홈이 첫 자리).
const items = [
  { href: "/", label: "홈", icon: HomeIcon },
  { href: "/schedule", label: "일정", icon: CalendarDaysIcon },
  { href: "/pipeline", label: "캠페인", icon: Table2Icon },
];

// /pipeline 과 /pipeline/tasks 가 부모-자식 경로라 startsWith 매칭이면 동시 활성 —
// 정확 일치만 사용한다(세 탭 모두 하위 경로 없음).
function isActive(pathname: string, href: string) {
  return pathname === href;
}

/** 스크롤 정지 후 재등장까지의 지연 — 라이브 시안에서 오너가 승인한 값(2026-07-16). */
const IDLE_REVEAL_MS = 180;
/** 이보다 작은 스크롤 이동은 무시 — 미세 떨림이 숨김을 트리거하지 않게. */
const SCROLL_DELTA_PX = 4;
/** 최상/최하단에서 이 거리 안이면 바운스 구간 — 숨김을 걸지 않는다. */
const BOUNCE_EDGE_PX = 2;

/**
 * idle-reveal — 스크롤 중에는 숨고, 멈추면 돌아온다(오너 확정 2026-07-16, 라이브 시안).
 *
 * - 리스너는 document **캡처** 하나 — scroll 은 버블링하지 않지만 캡처는 잡히므로,
 *   문서 스크롤과 내부 overflow 컨테이너를 모두 한 리스너로 덮는다(탭마다 스크롤
 *   컨테이너가 달라도 배관 불요).
 * - setState 는 hide/show 불리언 전환 시에만 리렌더를 만든다(같은 값 재설정은 무시됨)
 *   — 스크롤 프레임마다 리렌더 금지(styleseed anti-slop 5)와 양립.
 * - 스크롤 여지가 없는 화면(scrollHeight≈clientHeight)은 숨김을 걸지 않는다 —
 *   숨었다 못 돌아오는 사고 방지. 이벤트 시점마다 재평가하므로 콘텐츠 길이가
 *   런타임에 변해도 안전하다.
 * - 바운스(고무줄) 구간에서는 항상 표시 — iOS 탄성 스크롤이 "정지"처럼 보여도
 *   scroll 이벤트가 진동하는 구간이라 숨김이 오작동한다.
 * - reduced-motion 은 **숨김 자체를 끈다**(항상 표시) — 모션만 죽이고 on/off 를
 *   남기면 깜빡임이 되어 더 거슬린다(apple-design §14: 부드러운 대체, 제로가 아님).
 */
function useIdleRevealOnScroll(enabled: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  const timerRef = useRef<number | null>(null);
  const lastYRef = useRef(new WeakMap<Element, number>());

  useEffect(() => {
    if (!enabled) {
      setHidden(false);
      return;
    }
    const onScroll = (event: Event) => {
      const target = event.target;
      const el =
        target === document
          ? document.scrollingElement
          : target instanceof Element
            ? target
            : null;
      if (!el) return;

      const y = el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      // 스크롤 여지가 사실상 없는 컨테이너(탭 본문의 +1px 포함)는 무시.
      if (max <= SCROLL_DELTA_PX) return;

      const last = lastYRef.current.get(el) ?? y;
      lastYRef.current.set(el, y);

      if (y <= BOUNCE_EDGE_PX || y >= max - BOUNCE_EDGE_PX) {
        // 바운스 경계 — 표시 고정, 진행 중이던 재등장 타이머도 정리.
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = null;
        setHidden(false);
        return;
      }
      if (Math.abs(y - last) < SCROLL_DELTA_PX) return;

      setHidden(true);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setHidden(false);
      }, IDLE_REVEAL_MS);
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, [enabled]);

  return hidden;
}

export function MobileBottomNav() {
  const pathname = usePathname();
  const environment = useWebAppEnvironment();
  const [mounted, setMounted] = useState(false);
  const reducedMotion = useReducedMotion();
  const hidden = useIdleRevealOnScroll(mounted && !reducedMotion);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const isNoSidebarPage = ["/login", "/auth", "/privacy", "/coupang-partners", "/p/"].some((p) =>
    pathname.startsWith(p),
  );

  if (!environment.isReady || !environment.isMobile || !environment.isStandalone || isNoSidebarPage) {
    return null;
  }

  return (
    <>
      {/* 상태바 베일(추가개선 3, 오너 승인 2026-07-16) — viewportFit:cover 라 바운스
          (고무줄) 때 콘텐츠가 상태바 밑까지 당겨지는데, 그 순간 시계·배터리 뒤 톤이
          끊겨 보인다. 상태바 높이만큼 반투명 프로스트를 깔아 톤을 잇는다.
          이 컴포넌트에 두는 이유: 스탠드얼론+모바일+비로그인 게이트를 이미 통과한
          유일한 상시 마운트 지점이라서다. 데스크톱·일반 브라우저는 env()=0 → 높이 0.
          z-30 = 콘텐츠 위, nav(z-40)·시트(z-50) 아래. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[env(safe-area-inset-top,0px)] bg-slate-50/80 backdrop-blur-sm"
      />
      {/* 플로팅 카드(오너 확정 2026-07-16) — 구 풀폭 고정 바 폐기. 상단바(MobileTopBar)와
          같은 유리 카드 재질, 그림자는 사다리의 lg(플로팅 바 전용 층, design-system P8).

          여전히 position:fixed 다 — #192 의 "로딩↔본문 높이 급변 시 iOS 가 fixed 를 스테일
          오프셋으로 그리는" 회귀 조건을 그대로 상속하므로, 로딩 화면의
          min-h-[calc(100dvh+1px)] 계약(pipeline/loading.tsx 주석)은 이 컴포넌트의 하드
          의존성이다. transform 도 nav "자신"에만 건다 — 감싸는 요소에 걸면 그 조상이
          containing block 이 되어 fixed 좌표계가 깨진다(ss-ux 판정).

          숨김/등장은 CSS transition(인터럽터블 — 스크롤 재개 시 현재 위치에서 즉시 역방향)
          + transform/opacity 만(GPU). 비대칭 타이밍: 숨김 160ms(치워라=즉각) /
          등장 220ms(조심스럽게 복귀). 곡선은 iOS 시트 계열 커스텀 베지어. */}
      <nav
      className={cn(
        "fixed inset-x-3 z-40 rounded-2xl border border-white/60 bg-card/90 backdrop-blur-md shadow-soft-lg",
        "bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]",
        "transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
        hidden
          ? "duration-[160ms] translate-y-[calc(100%+env(safe-area-inset-bottom,0px)+0.75rem)] opacity-0"
          : "duration-[220ms] translate-y-0 opacity-100",
      )}
    >
      <div className="grid grid-cols-3 gap-1 px-2 py-1.5">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                // 터치 전용 표면이라 hover 상태를 두지 않는다(iOS sticky-hover 방지).
                // 프레스는 딤이다(오너 결정 2026-07-22, 축소는 그리드 타일 전용) — 배경
                // 틴트를 못 쓰는 이유는 이 표면에서 배경이 이미 "선택됨"(활성 탭
                // bg-primary/[0.08])을 뜻해 한 캐리어가 두 의미를 지고 경쟁하기 때문이다.
                //
                // 딤을 brightness 가 아니라 opacity 로 구현한다: filter 는 렌더 결과에
                // 곱연산이라 **비활성 탭처럼 배경이 투명한 요소에서는 어두워질 픽셀이
                // 아이콘 획과 11px 글자뿐**이라 사실상 무피드백이 된다(ss-ux 판정).
                // opacity 는 면 유무와 무관하게 내용 전체를 낮춰 두 상태 모두에서 읽힌다.
                "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[11px] font-medium transition-[color,background-color,opacity] duration-150 active:opacity-60",
                active ? "bg-primary/[0.08] text-primary" : "text-muted-foreground",
              )}
            >
              {/* 탭바 아이콘 20px + 활성 스트로크 가중 — 16px는 56px 탭 안에서 존재감이
                  약했다(토스 탭바는 24px 워크호스 + active filled 변형 관례). lucide 는
                  outline 단일 세트라 filled 대신 굵기(2.4)로 활성을 표현한다. */}
              <Icon className="size-5" strokeWidth={active ? 2.4 : 2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
      </nav>
    </>
  );
}
