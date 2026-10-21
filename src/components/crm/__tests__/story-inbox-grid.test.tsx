// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const classifyStory = vi.fn();
vi.mock("@/app/admin/stories/actions", () => ({
  classifyStory: (...args: unknown[]) => classifyStory(...args),
}));
const toastError = vi.fn();
vi.mock("@/lib/toast", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import { StoryInboxGrid } from "@/components/crm/story-inbox-grid";
import { applyOverrides, type StoryInboxCard } from "@/lib/story-inbox";

/**
 * 분류 버튼은 서버 응답을 기다리지 않고 **즉시** 화면을 바꿔야 한다 — 예전엔 저장은 됐는데 서버
 * 왕복 + 페이지 재계산 동안 화면이 그대로라 "안 눌렸다"로 보였다(2026-10-21 오너 제보).
 */
const card = (id: string, takenAtLabel: string): StoryInboxCard => ({
  id,
  displayName: "테스트셀러",
  img: null,
  isVideo: false,
  sourceUrlOnly: false,
  takenAtLabel,
  snsHandle: "test",
  classification: "UNREVIEWED",
});

const cards = [card("a", "01.02 03:04"), card("b", "01.01 09:00")];
const counts = { UNREVIEWED: 10, CAMPAIGN: 5, OTHER: 3 };

function tabText(label: string) {
  return screen.getByRole("link", { name: new RegExp(`^${label} `) }).textContent;
}

// 느린 서버 흉내 — 테스트가 끝나면 반드시 응답시킨다. React 는 진행 중인 비동기 전환이 **전부**
// 끝나야 낙관적 상태를 되돌리므로, 응답 없는 요청이 남으면 다음 테스트의 복원까지 막는다.
let releaseSlow: (() => void)[] = [];
function slowServer() {
  return new Promise<void>((resolve) => releaseSlow.push(resolve));
}

describe("StoryInboxGrid — 누르는 즉시 반영", () => {
  beforeEach(() => {
    classifyStory.mockReset();
    toastError.mockReset();
  });
  afterEach(async () => {
    await act(async () => {
      releaseSlow.forEach((r) => r());
    });
    releaseSlow = [];
    vi.restoreAllMocks();
  });

  it("저장이 끝나기 전에 카드가 빠지고 탭 개수가 바뀐다", async () => {
    classifyStory.mockImplementation(slowServer);
    render(<StoryInboxGrid filter="unreviewed" cards={cards} counts={counts} total={18} />);

    const first = screen.getByText(/01\.02 03:04/).closest("div.rounded-xl") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "캠페인" }));
    });

    expect(screen.queryByText(/01\.02 03:04/)).toBeNull();
    expect(screen.getByText(/01\.01 09:00/)).toBeTruthy();
    expect(tabText("미분류")).toBe("미분류 9");
    expect(tabText("캠페인 홍보")).toBe("캠페인 홍보 6");
    expect(tabText("전체")).toBe("전체 18");
    expect(classifyStory).toHaveBeenCalledWith("a", "CAMPAIGN");
  });

  it("⛔ 저장이 실패하면 카드가 돌아오고 오류 알림이 뜬다 (무음 실패 금지)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    classifyStory.mockRejectedValue(new Error("boom"));
    render(<StoryInboxGrid filter="unreviewed" cards={cards} counts={counts} total={18} />);

    const first = screen.getByText(/01\.02 03:04/).closest("div.rounded-xl") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "무관" }));
    });

    expect(await screen.findByText(/01\.02 03:04/)).toBeTruthy();
    expect(tabText("미분류")).toBe("미분류 10");
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("전체 탭에서는 카드가 남고 버튼이 즉시 되돌리기로 바뀐다", async () => {
    classifyStory.mockImplementation(slowServer);
    render(<StoryInboxGrid filter="all" cards={cards} counts={counts} total={18} />);

    const first = screen.getByText(/01\.02 03:04/).closest("div.rounded-xl") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(first).getByRole("button", { name: "무관" }));
    });

    expect(within(first).getByRole("button", { name: "무관 (되돌리기)" })).toBeTruthy();
    expect(tabText("무관")).toBe("무관 4");
  });
});

describe("applyOverrides — 개수 계산", () => {
  it("덮어쓰기가 없으면 서버 개수를 그대로 쓴다", () => {
    expect(applyOverrides(cards, counts, {}).counts).toEqual(counts);
  });

  it("원래 분류와 같은 값으로 덮어쓰면 개수가 변하지 않는다", () => {
    expect(applyOverrides(cards, counts, { a: "UNREVIEWED" }).counts).toEqual(counts);
  });
});

describe("story-inbox-grid 모듈 경계", () => {
  /**
   * "use client" 모듈에서 내보낸 상수·함수를 서버 페이지가 가져오면 실제 값이 아니라 클라이언트 참조가
   * 와서 런타임에 죽는다(2026-10-21 실렌더: `.find is not a function`). 타입체크·단위 테스트로는 안 보인다.
   * 서버와 공유할 것은 `src/lib/story-inbox.ts` 에 둔다 — 이 모듈은 컴포넌트만 내보낸다.
   */
  it("컴포넌트 하나만 내보낸다", async () => {
    const mod = await import("@/components/crm/story-inbox-grid");
    expect(Object.keys(mod)).toEqual(["StoryInboxGrid"]);
  });
});
