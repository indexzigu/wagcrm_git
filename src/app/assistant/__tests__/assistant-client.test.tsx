// @vitest-environment jsdom
/**
 * AssistantClient — 결재함 링크 회귀 테스트 (Plan 2 Task 3).
 *
 * 승인 대기함 패널(ApprovalInbox, 탭 포함)은 이 페이지에서 제거됐다 — 탭 UI는
 * 결재함 허브(/approvals, Task 4)가 소유한다. 이 페이지는 그 허브로 가는
 * 한 줄 링크만 남긴다(청사진 §0-8).
 *
 * 채팅 영속화(§3) 도입 이후 마운트 시 GET /api/assistant/conversations를 호출하므로,
 * 이 회귀 스위트에서도 전역 fetch를 스텁한다(그렇지 않으면 실제 네트워크 호출 시도).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AssistantClient } from "../assistant-client";

describe("AssistantClient — 결재함 링크", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("결재함으로 가는 링크가 어시스턴트 페이지 내부에 렌더링된다", async () => {
    render(<AssistantClient />);
    const link = screen.getByRole("link", { name: "결재함에서 기안을 확인합니다" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/approvals");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("어시스턴트 채팅 UI(전송 버튼)도 함께 렌더링된다 (기존 기능 유지)", async () => {
    render(<AssistantClient />);
    expect(screen.getByLabelText("전송")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
