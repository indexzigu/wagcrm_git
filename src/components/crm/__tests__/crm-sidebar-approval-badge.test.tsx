/**
 * ApprovalBadge — 사이드바 승인대기 배지 (청사진 §6-2, §6-3).
 *
 * CrmSidebar 전체를 렌더하려면 SidebarProvider/next-navigation/supabase 클라이언트 등
 * 무관한 의존성이 커지므로, 배지 로직만 단위로 검증한다(ApprovalBadge는 crm-sidebar.tsx가
 * export하는 실제 배지 컴포넌트 — §6-2 "count>0일 때만 렌더" 요구 그대로).
 * useApprovalInbox("PENDING_APPROVAL")와 동일 쿼리키를 공유하는지는 두 번째 테스트에서
 * 같은 QueryClient 아래 두 훅 소비자를 렌더해 fetch가 1회만 발생함으로 확인한다
 * (§6-2 "추가 폴링 없이 캐시 공유").
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ApprovalBadge } from "../crm-sidebar";
import { useApprovalInbox } from "@/hooks/useApprovalInbox";

function renderWithClient(ui: React.ReactElement, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return { ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>), queryClient };
}

describe("ApprovalBadge (사이드바 승인대기 배지, §6-2)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("대기 건수가 0이면 배지를 렌더하지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items: [], count: 0 }) });
    const { container } = renderWithClient(<ApprovalBadge />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals?status=PENDING_APPROVAL");
    });
    // count=0이면 배지 요소 자체가 없어야 한다(빈 문자열 렌더도 아님).
    expect(container.textContent).toBe("");
  });

  it("대기 건수가 N건이면 N을 표시한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }], count: 3 }),
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApprovalBadge />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("useApprovalInbox('PENDING_APPROVAL')와 동일 쿼리키를 공유해 추가 폴링을 만들지 않는다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: "p1" }], count: 1 }),
    });

    function OtherConsumer() {
      const { count } = useApprovalInbox("PENDING_APPROVAL");
      return <span data-testid="other-consumer">{count}</span>;
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ApprovalBadge />
        <OtherConsumer />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("other-consumer").textContent).toBe("1");
    });
    expect(screen.getAllByText("1")).toHaveLength(2);

    // 동일 쿼리키(캐시) 공유이므로 fetch는 한 번만 일어난다(각자 별도 요청이면 2회 이상).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
