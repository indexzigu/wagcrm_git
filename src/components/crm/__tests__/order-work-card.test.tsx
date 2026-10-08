// @vitest-environment jsdom
/**
 * 홈 「오늘 처리할 주문」 카드 — 상태 계약.
 *
 * P2 Decision-Value: 일이 있으면 0 이 아닌 칸만 강조하고, 전부 0 이면 조용한 한 줄로 물러난다.
 * 동기화가 평소 주기(매일 09:00 크론 → 26시간)를 넘겨 낡았으면 0 을 믿을 수 없으니 「확인불가」라고
 * 말한다. 카드 전체가 주문 관리로 가는 링크 하나다(탭 정지 1회, 이름 = 보이는 글자).
 */
import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderWorkCard } from "../order-work-card";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

const HOUR = 3_600_000;

function summary(overrides: Partial<OrderWorkSummary> = {}): OrderWorkSummary {
  return {
    awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 0,
    lastSyncAt: new Date(Date.now() - HOUR).toISOString(),
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

const busy = () =>
  summary({
    awaitingPo: { lines: 12, campaigns: 3, delayedLines: 5 },
    delayed: { lines: 4, campaigns: 2, invoiceLines: 3, shippingLines: 1 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 16,
  });

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
    fetchMock.mockResolvedValue({ ok: true, json: async () => busy() });
    const { container } = renderCard();
    await screen.findByText("결제 후 2일 이상 5건");
    expect(fetchMock).toHaveBeenCalledWith("/api/order-work");

    const cell = (key: string) => container.querySelector(`[data-bucket="${key}"]`) as HTMLElement;
    const awaiting = cell("awaiting-po");
    expect(within(awaiting).getByText("발주 대기")).toBeInTheDocument();
    expect(within(awaiting).getByText("12")).toHaveClass("font-bold");
    expect(within(awaiting).getByText("· 캠페인 3개")).toBeInTheDocument();
    expect(within(awaiting).getByText("결제 후 2일 이상 5건")).toHaveClass("text-status-caution-text");

    // 주문 관리 화면의 「송장 지연」「배송 지연」을 같은 뜻으로 세부 줄에 쓴다.
    const delayed = cell("delayed");
    expect(within(delayed).getByText("송장·배송 지연")).toBeInTheDocument();
    expect(within(delayed).getByText("송장 지연 3건 · 배송 지연 1건")).toHaveClass("text-status-urgent-text");

    // 0 인 칸은 남되 물러난다 — 굵은 숫자·캠페인 수·색 점이 없다.
    const claims = cell("open-claims");
    expect(within(claims).getByText("반품/교환")).toBeInTheDocument();
    expect(within(claims).getByText("0")).not.toHaveClass("font-bold");
    expect(within(claims).queryByText(/캠페인/)).not.toBeInTheDocument();
    expect(claims.querySelector(".rounded-full")).toBeNull();

    expect(screen.queryByText("0건")).not.toBeInTheDocument();
  });

  it("반품/교환은 주문 관리의 반품/교환 버튼과 같은 위험색, 못 찾은 캠페인은 건수로 말한다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => summary({ openClaims: { lines: 2, campaigns: 1, unmatchedLines: 1 }, total: 2 }),
    });
    const { container } = renderCard();
    const detail = await screen.findByText("캠페인 못 찾은 1건");
    expect(detail).toHaveClass("text-status-urgent-text");
    expect(container.querySelector('[data-bucket="open-claims"] .bg-status-urgent')).not.toBeNull();
  });

  it("카드 전체가 주문 관리로 가는 링크 하나다 — 이름은 보이는 글자 그대로(aria-label 없음)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => busy() });
    renderCard();
    await screen.findByText("결제 후 2일 이상 5건");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/order-converter");
    expect(links[0]).not.toHaveAttribute("aria-label");
    expect(links[0]).toHaveAccessibleName(expect.stringContaining("발주 대기"));
  });

  it("전부 0 이고 동기화가 신선하면 조용한 한 줄 「0건」만 남는다(할 일 없음 = 값, 점·색 없음)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary() });
    const { container } = renderCard();
    const zero = await screen.findByText("0건");
    expect(zero).toHaveClass("text-slate-600");
    expect(zero.querySelector(".bg-status-caution")).toBeNull();
    expect(container.querySelector("[data-bucket]")).toBeNull();
    expect(screen.getByText(/^마지막 동기화 /)).toBeInTheDocument();
  });

  it("동기화가 26시간을 넘겨 낡았으면 0 이어도 「확인불가」(점+낱말)와 「마지막 동기화 N일 전」을 주의색으로", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => summary({ lastSyncAt: new Date(Date.now() - 50 * HOUR).toISOString() }),
    });
    renderCard();
    // StatusDot — 낱말은 안쪽 span, 색·점은 바깥 span 이 진다(색만으로 전하지 않는다).
    const flag = (await screen.findByText("확인불가")).parentElement!;
    expect(flag).toHaveClass("text-status-caution-text");
    expect(flag.querySelector(".bg-status-caution")).not.toBeNull();
    expect(screen.getByText("마지막 동기화 2일 전")).toHaveClass("text-status-caution-text");
    expect(screen.queryByText("0건")).not.toBeInTheDocument();
  });

  it("스냅샷이 없으면 「동기화대기」 한 마디만 — 「0건」도 중복 문구도 없다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary({ hasSnapshot: false, lastSyncAt: null }) });
    renderCard();
    expect(await screen.findByText("동기화대기")).toBeInTheDocument();
    expect(screen.queryByText("0건")).not.toBeInTheDocument();
    expect(screen.queryByText(/동기화 기록 없음|아직 동기화된 주문이 없습니다/)).not.toBeInTheDocument();
  });

  it("불러오지 못하면 오류를 드러내고 다시 불러오기를 제공한다(빈 상태로 위장하지 않는다)", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "집계 실패" }) });
    renderCard();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("집계 실패")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "다시 불러오기" })).toBeInTheDocument();
    expect(screen.queryByText("0건")).not.toBeInTheDocument();
  });

  it("로딩 중에는 헤더 한 줄만 — 칸 스켈레톤이 없어 조용한 날 홈이 튀지 않는다", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = renderCard();
    expect(screen.getByText("오늘 처리할 주문")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
    expect(container.querySelector(".grid")).toBeNull();
  });

  it("데이터가 오면 스켈레톤이 사라진다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => summary() });
    const { container } = renderCard();
    await waitFor(() => expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0));
  });

  it("글자는 text-xs(12px) 아래로 내려가지 않는다", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => busy() });
    const { container } = renderCard();
    await screen.findByText("결제 후 2일 이상 5건");
    const tiny = [...container.querySelectorAll("*")].filter((el) => /text-\[(9|10|11)px\]/.test(el.getAttribute("class") ?? ""));
    expect(tiny).toEqual([]);
  });
});
