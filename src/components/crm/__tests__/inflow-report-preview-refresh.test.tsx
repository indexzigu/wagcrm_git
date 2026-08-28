// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkDetailSheet } from "@/components/crm/inflow-report-client";
import type { InflowLinkRow } from "@/lib/inflow-report";

/**
 * 유입 리포트는 지금까지 읽기 전용 분석 표면이었다 — 쓰기 액션이 처음 들어간다.
 * 본업(유입 분석)을 밀지 않도록 1행으로 고정하고, 소스는 시트의 다른 콘텐츠와
 * 같은 `snapshot` 을 쓴다(닫힘 애니메이션 중 그 줄만 먼저 사라지지 않게).
 */

function makeRow(overrides: Partial<InflowLinkRow> = {}): InflowLinkRow {
  return {
    code: "Kp7mQ2xd",
    shortUrl: "https://go.ygrd.kr/Kp7mQ2xd",
    ogTitle: "여름 공구",
    ogImage: null,
    ogFetchedAt: null,
    ...overrides,
  } as InflowLinkRow;
}

// ⚠️ jsdom 은 실제 CSS 애니메이션 엔진이 없다 — Radix `Presence` 는 닫힘 시
// `getComputedStyle().animationName` 이 "none" 이면 exit 애니메이션 없이 그
// 자리에서(동기) 시트 전체를 언마운트해 버린다. 그러면 아래 두 번째 테스트는
// `link` 를 쓰든 `snapshot` 을 쓰든 항상 실패해(전체 서브트리가 통째로 사라져)
// 정작 지키려는 회귀(그 줄만 먼저 사라짐)를 구분하지 못한다. `data-state`
// (open/closed) 에 따라 다른 애니메이션 이름을 흉내 내 Radix 가 "닫힘 애니메이션
// 진행 중" 으로 인식하게 만들어야 시트가 즉시 사라지지 않고, 그 안에서 `snapshot`
// 소스만 값을 유지하는지를 검증할 수 있다.
let restoreGetComputedStyle: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ stats: null }), { status: 200 })),
  );

  const realGetComputedStyle = window.getComputedStyle.bind(window);
  const spy = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((el: Element, pseudo?: string | null) => {
      const real = realGetComputedStyle(el, pseudo ?? undefined);
      const state = el.getAttribute?.("data-state");
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === "animationName") {
            return state === "closed" ? "sheet-exit" : "sheet-enter";
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
  restoreGetComputedStyle = () => spy.mockRestore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreGetComputedStyle?.();
  restoreGetComputedStyle = null;
});

describe("LinkDetailSheet — 미리보기 새로고침", () => {
  it("링크를 열면 새로고침 액션과 현재 미리보기를 보여준다", async () => {
    render(<LinkDetailSheet link={makeRow()} onOpenChange={() => {}} />);
    expect(await screen.findByRole("button", { name: /새로고침/ })).toBeInTheDocument();
    expect(screen.getByText("여름 공구")).toBeInTheDocument();
  });

  it("닫히는 동안에도 그 줄이 남는다 — snapshot 을 소비한다", async () => {
    const { rerender } = render(<LinkDetailSheet link={makeRow()} onOpenChange={() => {}} />);
    await screen.findByRole("button", { name: /새로고침/ });
    // link 가 null 이 되는 것이 닫힘의 시작이다. 애니메이션 동안 내용은 남아야 한다.
    rerender(<LinkDetailSheet link={null} onOpenChange={() => {}} />);
    expect(screen.getByText("여름 공구")).toBeInTheDocument();
  });
});
