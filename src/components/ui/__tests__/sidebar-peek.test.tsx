// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import {
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  Sidebar,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebarPeek,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * peek(호버 오버레이) 모드의 **핵심 불변식**: 흐름 안의 빈 칸(`sidebar-gap`)은 펼침
 * 상태를 따라가지 않는다. 이게 깨지면 호버가 본문을 밀어내고, 이 설계 전체가
 * 무의미해진다.
 *
 * 설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md`
 */
function renderSidebar({ peek, open }: { peek: boolean; open: boolean }) {
  return render(
    <SidebarProvider open={open} onOpenChange={() => {}}>
      <Sidebar collapsible="icon" peek={peek} data-testid="bar">
        <div>내용</div>
      </Sidebar>
    </SidebarProvider>,
  );
}

function gapOf(container: HTMLElement) {
  const gap = container.querySelector('[data-slot="sidebar-gap"]');
  if (!gap) throw new Error("sidebar-gap 이 렌더되지 않았다 — 판정 대상 부재");
  return gap.className;
}

describe("Sidebar peek 모드 — 빈 칸은 펼침을 따라가지 않는다", () => {
  it("판정 대상이 실제로 존재한다 (스캐너 양성 대조군)", () => {
    const { container } = renderSidebar({ peek: true, open: false });
    expect(gapOf(container)).toContain("--sidebar-width-icon");
    expect(screen.getByTestId("bar")).toBeTruthy();
  });

  /**
   * 🪤 **클래스 문자열 대조로는 이 성질을 못 잡는다.** 빈 칸의 className 은 두 상태에서
   * 어차피 같고, 폭 차이는 부모의 `data-collapsible` 속성이 `group-data-*` 변형을
   * 켜고 끄면서 만든다. 그래서 판정은 "문자열이 같은가"가 아니라 **"폭이 상태에
   * 의존하는 선언을 갖는가"** 로 한다(초판이 전자로 썼다가 음성 대조군이 무너졌다).
   */
  const stateDependentWidth = (className: string) =>
    className.split(/\s+/).filter((token) => token.startsWith("group-data-") && token.includes(":w-"));

  it("peek 이면 빈 칸 폭이 상태에 의존하지 않는다 — 이게 곧 '본문이 안 밀린다'", () => {
    const { container } = renderSidebar({ peek: true, open: false });
    expect(stateDependentWidth(gapOf(container))).toEqual([]);
  });

  it("peek 이 아니면 빈 칸 폭이 상태에 의존한다 (음성 대조군 — 판정기가 살아있다)", () => {
    const { container } = renderSidebar({ peek: false, open: false });
    expect(stateDependentWidth(gapOf(container)).length).toBeGreaterThan(0);
  });

  it("⛔ 이징은 ease-out 이다 — 상류 기본값 ease-linear 로 되돌리면 실패한다", () => {
    // 오너가 승인한 목업이 ease-out 이었다. 등속(linear)은 도착이 뭉개져
    // **승인된 느낌과 다른 구현**이 된다(review-animations 기준 3).
    const { container } = renderSidebar({ peek: true, open: false });
    const panel = container.querySelector('[data-slot="sidebar-container"]');
    const tokens = panel!.className.split(/\s+/);
    expect(tokens).toContain("ease-out");
    expect(tokens).not.toContain("ease-linear");
  });

  it("peek 펼침에서만 층 그림자가 붙는다 — shadow-overlay 는 쓰지 않는다(P8)", () => {
    const { container } = renderSidebar({ peek: true, open: true });
    const panel = container.querySelector('[data-slot="sidebar-container"]');
    expect(panel).not.toBeNull();
    expect(panel!.className).toContain("shadow-soft-lg");
    expect(panel!.className).not.toContain("shadow-overlay");
  });
});

/**
 * 호버와 포커스는 **하나의 합성 조건**이다(설계서 §5-3).
 *
 * ⛔ 두 트리거를 독립 처리하면, 마우스로 펼치고 Tab 으로 항목에 간 뒤 마우스만 치웠을 때
 * **키보드로 라벨을 읽는 도중 패널이 닫힌다.** 아래 네 번째 테스트가 그 사고를 고정한다.
 *
 * ⚠️ `vi.useFakeTimers()` 를 인자 없이 쓰지 말 것 — 기본값은 `Date` 까지 얼려
 * testing-library 를 망가뜨린다(이 레포의 반복 함정).
 */
function PeekHarness() {
  const peekHandlers = useSidebarPeek();
  return (
    <Sidebar collapsible="icon" peek {...peekHandlers} data-testid="bar">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton>대시보드</SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </Sidebar>
  );
}

function renderHarness() {
  const utils = render(
    <SidebarProvider>
      <PeekHarness />
    </SidebarProvider>,
  );
  const root = utils.container.querySelector('[data-slot="sidebar"]') as HTMLElement;
  return { ...utils, root, bar: screen.getByTestId("bar") };
}

const stateOf = (root: HTMLElement) => root.getAttribute("data-state");

function withFakeTimers(body: () => void) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    body();
  } finally {
    vi.useRealTimers();
  }
}

describe("사이드바 peek — 호버와 포커스는 하나의 합성 조건이다", () => {
  it("판정 대상이 실제로 존재하고 레일에서 시작한다 (양성 대조군)", () => {
    const { root } = renderHarness();
    expect(root).not.toBeNull();
    expect(stateOf(root)).toBe("collapsed");
  });

  it("마우스를 올리면 즉시 펼쳐진다", () => {
    const { root, bar } = renderHarness();
    fireEvent.mouseEnter(bar);
    expect(stateOf(root)).toBe("expanded");
  });

  it("마우스를 떼면 지연 뒤에 접힌다 — 지연 전에는 열려 있다", () => {
    withFakeTimers(() => {
      const { root, bar } = renderHarness();
      fireEvent.mouseEnter(bar);
      fireEvent.mouseLeave(bar);
      expect(stateOf(root)).toBe("expanded");
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS + 1);
      });
      expect(stateOf(root)).toBe("collapsed");
    });
  });

  it("⛔ 포커스가 안에 있으면 마우스를 떼도 접히지 않는다 (합성 조건 — 독립 처리 금지)", () => {
    withFakeTimers(() => {
      const { root, bar } = renderHarness();
      fireEvent.mouseEnter(bar);
      fireEvent.focus(screen.getByRole("button", { name: "대시보드" }));
      fireEvent.mouseLeave(bar);
      act(() => {
        vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS * 4);
      });
      expect(stateOf(root)).toBe("expanded");
    });
  });

  it("마우스 없이 포커스만으로도 펼쳐진다 (키보드 전용 사용자)", () => {
    const { root } = renderHarness();
    fireEvent.focus(screen.getByRole("button", { name: "대시보드" }));
    expect(stateOf(root)).toBe("expanded");
  });
});

/**
 * 펼쳐지면 라벨이 이미 보이므로, 뒤이어 뜨는 툴팁은 같은 라벨을 옆에 한 번 더 쓴다.
 * 툴팁이 원래 하던 일(아이콘만 있을 때 정체 식별)은 펼침이 완전히 대체한다(설계서 §5-4).
 */
describe("펼침 상태에서는 행 툴팁을 띄우지 않는다", () => {
  const TOOLTIP_TEXT = "판매 관리: 활성 캠페인 현황";

  /**
   * 툴팁은 **포커스로 연다** — Radix 는 포커스에 지연 없이 열리므로 가짜 타이머가
   * 필요 없다. 실앱의 `TooltipProvider` 는 루트 레이아웃에 있다.
   */
  function openTooltip(open: boolean) {
    render(
      <TooltipProvider>
        <SidebarProvider open={open} onOpenChange={() => {}}>
          <Sidebar collapsible="icon" peek>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={TOOLTIP_TEXT}>판매 관리</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </Sidebar>
        </SidebarProvider>
      </TooltipProvider>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "판매 관리" }));
    // 포털로 나가므로 document 전체에서 찾는다.
    return Array.from(document.querySelectorAll("[data-slot=tooltip-content]"));
  }

  it("접힘에서는 툴팁이 보인다 (양성 대조군 — 판정기가 살아있다)", () => {
    const contents = openTooltip(false);
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.some((node) => !node.hasAttribute("hidden"))).toBe(true);
    expect(document.body.textContent).toContain("활성 캠페인 현황");
  });

  it("⛔ 펼침에서는 툴팁이 보이지 않는다 — isMobile 단독으로 되돌리면 실패한다", () => {
    const contents = openTooltip(true);
    expect(contents.every((node) => node.hasAttribute("hidden"))).toBe(true);
  });
});
