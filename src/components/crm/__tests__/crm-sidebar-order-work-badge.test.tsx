// @vitest-environment jsdom
/**
 * OrderWorkBadge — 사이드바 「주문 관리」 배지(발주 자동화 1단계, 오너 승인 2026-10-06).
 *
 * ApprovalBadge 와 같은 계약: 0 이면 렌더하지 않고, N 이면 N 을 보인다. 홈 「오늘 처리할 주문」
 * 카드와 같은 쿼리키를 공유해 두 소비처가 함께 떠 있어도 요청은 1회다(배지가 추가 폴링을 만들지
 * 않는다). CrmSidebar 전체 렌더는 무관한 의존성이 커서 배지만 단위로 본다.
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderWorkBadge } from "../crm-sidebar";
import { OrderWorkCard } from "../order-work-card";

function payload(total: number) {
  return {
    awaitingPo: { lines: total, campaigns: total > 0 ? 1 : 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total,
    lastSyncAt: new Date().toISOString(),
    activeCampaignCount: 1,
    hasSnapshot: true,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("OrderWorkBadge (사이드바 「주문 관리」 배지)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("처리할 주문이 0건이면 배지를 렌더하지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(0) });
    const { container } = renderWithClient(<OrderWorkBadge />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/order-work"));
    expect(container.textContent).toBe("");
  });

  it("N건이면 N을 표시하고 읽기 이름을 붙인다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(7) });
    renderWithClient(<OrderWorkBadge />);
    const badge = await screen.findByText("7");
    expect(badge).toHaveAttribute("aria-label", "오늘 처리할 주문 7건");
  });

  it("집계 실패면 배지를 숨긴다(오류는 홈 카드가 드러낸다)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "x" }) });
    const { container } = renderWithClient(<OrderWorkBadge />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("홈 카드와 같은 쿼리키를 공유해 요청을 1회만 만든다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(2) });
    renderWithClient(
      <>
        <OrderWorkBadge />
        <OrderWorkCard />
      </>,
    );
    await screen.findByRole("link", { name: /발주 대기 2건/ });
    expect(screen.getByLabelText("오늘 처리할 주문 2건")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
