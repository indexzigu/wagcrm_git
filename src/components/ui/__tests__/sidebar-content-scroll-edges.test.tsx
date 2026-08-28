import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SidebarContent } from "@/components/ui/sidebar";

/**
 * 스크롤 엣지 판정 — 잘린 쪽에만 페이드가 켜진다.
 *
 * jsdom 은 레이아웃을 계산하지 않으므로 scrollHeight/clientHeight/scrollTop 을
 * 주입한다. 실측 기준값은 1440x900 데스크톱 사이드바(scrollHeight 754 ·
 * clientHeight 687 · 최대 스크롤 67)다.
 */

const CONTENT = 754;
const VIEWPORT = 687;
const MAX = CONTENT - VIEWPORT; // 67

function setMetrics(
  el: HTMLElement,
  { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
}

function renderContent() {
  const { container } = render(
    <SidebarContent>
      <div>항목</div>
    </SidebarContent>,
  );
  const el = container.querySelector<HTMLElement>('[data-slot="sidebar-content"]');
  if (!el) throw new Error("sidebar-content 를 찾지 못했다");
  return el;
}

/** 지표를 바꾼 뒤 판정을 다시 돌린다(실제로도 scroll 이벤트가 트리거다). */
function measure(el: HTMLElement, metrics: Parameters<typeof setMetrics>[1]) {
  setMetrics(el, metrics);
  fireEvent.scroll(el);
  return { top: el.dataset.fadeTop, bottom: el.dataset.fadeBottom };
}

describe("SidebarContent 스크롤 엣지 판정", () => {
  it("맨 위 — 아래만 잘려 있다", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: 0 })).toEqual({
      top: "false",
      bottom: "true",
    });
  });

  it("중간 — 양쪽 다 잘려 있다", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: 30 })).toEqual({
      top: "true",
      bottom: "true",
    });
  });

  it("맨 아래 — 위만 잘려 있다", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: MAX })).toEqual({
      top: "true",
      bottom: "false",
    });
  });

  it("넘치지 않으면 양쪽 다 꺼진다 (1080p 등 큰 뷰포트)", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: CONTENT, scrollTop: 0 })).toEqual({
      top: "false",
      bottom: "false",
    });
  });

  // 아래 두 건이 임계값(epsilon)을 고정한다. 정확 비교(scrollTop === max)를 쓰면
  // 브라우저가 주는 소수 잔여(0.5px)에 걸려 하단 페이드가 영영 꺼지지 않는다.
  it("경계 안쪽 — 소수 잔여는 '끝에 닿았다'로 본다", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: MAX - 0.5 })).toEqual({
      top: "true",
      bottom: "false",
    });
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: 0.5 })).toEqual({
      top: "false",
      bottom: "true",
    });
  });

  it("경계 바깥 — 임계를 넘은 스크롤은 잘림으로 본다", () => {
    const el = renderContent();
    expect(measure(el, { scrollHeight: CONTENT, clientHeight: VIEWPORT, scrollTop: 1.5 })).toEqual({
      top: "true",
      bottom: "true",
    });
  });
});
