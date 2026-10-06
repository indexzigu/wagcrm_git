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

function payload(total: number, extra: Record<string, unknown> = {}) {
  return {
    awaitingPo: { lines: total, campaigns: total > 0 ? 1 : 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total,
    lastSyncAt: new Date().toISOString(),
    activeCampaignCount: 1,
    hasSnapshot: true,
    ...extra,
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

  it("N건이면 N을 보이고, 화면 낭독기에는 「오늘 처리할 주문 N건」으로 읽힌다(역할 없는 span 에 aria-label 금지)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload(7) });
    const { container } = renderWithClient(<OrderWorkBadge />);
    await waitFor(() => expect(container.textContent).toBe("오늘 처리할 주문 7건"));
    const badge = container.querySelector('[data-slot="badge"]')!;
    expect(badge).not.toHaveAttribute("aria-label");
    // 보이는 글자는 숫자뿐(사이드바 승인 배지와 같은 모양) — 나머지는 sr-only.
    const visible = [...badge.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only")));
    expect(visible.map((n) => n.textContent).join("")).toBe("7");
  });

  it("평상시 발주 대기만 있으면 무채색(늘 켜진 주황 배지 금지), 늦은 건이 있을 때만 색을 받는다", async () => {
    const variantOf = async (body: unknown) => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body });
      const { container, unmount } = renderWithClient(<OrderWorkBadge />);
      await waitFor(() => expect(container.querySelector('[data-slot="badge"]')).not.toBeNull());
      const variant = container.querySelector('[data-slot="badge"]')!.getAttribute("data-variant");
      unmount();
      return variant;
    };
    expect(await variantOf(payload(3))).toBe("secondary");
    expect(await variantOf(payload(3, { awaitingPo: { lines: 3, campaigns: 1, delayedLines: 1 } }))).toBe("status-caution");
    expect(
      await variantOf(payload(2, { awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 }, delayed: { lines: 2, campaigns: 1, invoiceLines: 2, shippingLines: 0 } })),
    ).toBe("status-urgent");
    expect(
      await variantOf(payload(1, { awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 }, openClaims: { lines: 1, campaigns: 1, unmatchedLines: 0 } })),
    ).toBe("status-urgent");
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
    await screen.findByRole("link", { name: /발주 대기/ });
    await screen.findByText("오늘 처리할 주문", { selector: ".sr-only" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
