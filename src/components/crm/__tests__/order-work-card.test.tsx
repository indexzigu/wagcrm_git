// @vitest-environment jsdom
/**
 * 홈 「오늘 처리할 주문」 카드 — 상태 계약.
 *
 * P2 Decision-Value: 일이 있으면 0 이 아닌 칸만 강조하고, 전부 0 이면 조용한 한 줄로 물러난다.
 * 칸을 누르면 주문 관리로 간다(주문 관리에는 필터 파라미터가 없어 화면 자체로 보낸다).
 * 기준 시각(마지막 동기화)을 항상 보여준다 — 숫자가 언제 기준인지 모르면 0 을 믿을 수 없다.
 */
import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderWorkCard } from "../order-work-card";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

function summary(overrides: Partial<OrderWorkSummary> = {}): OrderWorkSummary {
  return {
    awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 0,
    lastSyncAt: new Date().toISOString(),
    activeCampaignCount: 3,
    hasSnapshot: true,
    ...overrides,
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OrderWorkCard />
    </QueryClientProvider>,
  );
}

describe("OrderWorkCard", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("일이 있으면 세 칸을 보여주고, 0 이 아닌 칸만 숫자를 강조한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        summary({
          awaitingPo: { lines: 12, campaigns: 3, delayedLines: 5 },
          delayed: { lines: 4, campaigns: 2, invoiceLines: 3, shippingLines: 1 },
          openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
          total: 16,
        }),
    });
    renderCard();

    const awaiting = await screen.findByRole("link", { name: /발주 대기 12건/ });
    expect(fetchMock).toHaveBeenCalledWith("/api/order-work");
    expect(within(awaiting).getByText("12")).toHaveClass("font-bold");
    expect(within(awaiting).getByText("· 캠페인 3개")).toBeInTheDocument();
    expect(within(awaiting).getByText("그중 2일 넘은 5건")).toBeInTheDocument();

    const delayed = screen.getByRole("link", { name: /배송 지연 4건/ });
    expect(within(delayed).getByText("송장 미회신 3 · 배송 5일 이상 1")).toHaveClass("text-status-urgent-text");

    // 0 인 칸은 남되 물러난다 — 굵은 숫자·캠페인 수·색 점이 없다.
    const claims = screen.getByRole("link", { name: /진행 중 클레임 0건/ });
    expect(within(claims).getByText("0")).not.toHaveClass("font-bold");
    expect(within(claims).queryByText(/캠페인/)).not.toBeInTheDocument();
    expect(claims.querySelector(".rounded-full")).toBeNull();

    expect(screen.queryByText("처리할 주문 없음")).not.toBeInTheDocument();
  });

  it("모든 칸이 주문 관리로 간다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => summary({ awaitingPo: { lines: 1, campaigns: 1, delayedLines: 0 }, total: 1 }),
    });
    renderCard();
    await screen.findByRole("link", { name: /발주 대기 1건/ });
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(new Set(hrefs)).toEqual(new Set(["/order-converter"]));
    expect(hrefs.length).toBe(4); // 세 칸 + 헤더 「주문 관리」
  });

  it("전부 0 이면 조용한 한 줄 「처리할 주문 없음」만 남고 칸은 그리지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary() });
    renderCard();
    expect(await screen.findByText("처리할 주문 없음")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /발주 대기/ })).not.toBeInTheDocument();
    expect(screen.getByText(/^마지막 동기화 /)).toBeInTheDocument();
  });

  it("활성 캠페인은 있는데 스냅샷이 없으면 0 이 아니라 「아직 동기화된 주문이 없습니다」라고 말한다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary({ hasSnapshot: false, lastSyncAt: null }) });
    renderCard();
    expect(await screen.findByText("아직 동기화된 주문이 없습니다")).toBeInTheDocument();
    expect(screen.queryByText("처리할 주문 없음")).not.toBeInTheDocument();
    expect(screen.getByText("동기화 기록 없음")).toBeInTheDocument();
  });

  it("불러오지 못하면 오류를 드러내고 다시 불러오기를 제공한다(빈 상태로 위장하지 않는다)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "집계 실패" }) });
    renderCard();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("집계 실패")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "다시 불러오기" })).toBeInTheDocument();
    expect(screen.queryByText("처리할 주문 없음")).not.toBeInTheDocument();
  });

  it("로딩 중에는 칸 모양의 스켈레톤을 그린다", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderCard();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("처리할 주문 없음")).not.toBeInTheDocument();
  });

  it("데이터가 오면 스켈레톤이 사라진다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary() });
    const { container } = renderCard();
    await waitFor(() => expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0));
  });
});
