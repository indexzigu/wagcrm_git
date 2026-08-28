// @vitest-environment jsdom
/**
 * AssistantClient — 승인 대기함(ApprovalInbox) 마운트 회귀 테스트 (청사진 §2 G3).
 * 사이드바 신규 메뉴 없이 /assistant 페이지 내부에 섹션으로 렌더링되어야 한다.
 *
 * 채팅 영속화(§3) 도입 이후 마운트 시 GET /api/assistant/conversations를 호출하므로,
 * 이 회귀 스위트에서도 전역 fetch를 스텁한다(그렇지 않으면 실제 네트워크 호출 시도).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/crm/assistant/approval-inbox", () => ({
  ApprovalInbox: () => <div data-testid="approval-inbox-stub">승인 대기함 스텁</div>,
}));

import { AssistantClient } from "../assistant-client";

describe("AssistantClient — ApprovalInbox 마운트", () => {
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

  it("승인 대기함 섹션이 어시스턴트 페이지 내부에 렌더링된다", async () => {
    render(<AssistantClient />);
    expect(screen.getByTestId("approval-inbox-stub")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("어시스턴트 채팅 UI(전송 버튼)도 함께 렌더링된다 (기존 기능 유지)", async () => {
    render(<AssistantClient />);
    expect(screen.getByLabelText("전송")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
