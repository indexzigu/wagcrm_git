// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";

// 주문 관리 카드의 「회신 도착 · N건 · HH:MM」 줄 — 실제 화면 컴포넌트를 띄워 배선을 본다.
// 판정(처리됨 여부)은 서버가 `invoiceReply` 로 준다(invoice-reply-status.test.ts 가 판정을 고정).
// 여기서 보는 것: 값이 있으면 송장회신 버튼 옆에 그 줄이 뜨고, null 이면 아무것도 안 뜬다.
// ⚠️ 외부 호출은 전부 fetch 목이다 — 실제로 나가는 요청은 없다.

const campaignList = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("xlsx", () => {
  const mod = {
    utils: { json_to_sheet: vi.fn(() => ({})), book_new: vi.fn(() => ({})), book_append_sheet: vi.fn() },
    writeFile: vi.fn(),
  };
  return { ...mod, default: mod };
});
vi.mock("../crm-shell", () => ({
  CrmShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/useCampaigns", () => ({
  useCampaigns: () => ({
    campaigns: campaignList.current,
    isLoading: false,
    fetchCampaigns: vi.fn(),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
    toggleCampaignStatus: vi.fn(),
    syncMeta: { lastSync: null, syncing: false, syncType: null },
    refreshNow: vi.fn(),
    refreshing: false,
  }),
}));
vi.mock("@/hooks/useNaverProducts", () => ({
  useNaverProducts: () => ({ naverProducts: [], isFetchingNaver: false, fetchNaverProducts: vi.fn() }),
}));
vi.mock("@/hooks/useClaims", () => ({
  useClaims: () => ({ claims: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

import OrderDashboard from "../order-dashboard";

const baseCampaign = {
  id: "order-1",
  name: "테스트 주문 캠페인",
  template: "brand",
  sellerName: "테스트 셀러",
  toEmail: "ops@example.com",
  ccEmail: "",
  tasks: [],
  mappings: [],
  salesCampaigns: [],
  dailyStats: [],
  insights: null,
  isActive: true,
  pendingCount: 3,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T08:00:00Z")); // KST 17:00
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ logs: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("주문 관리 카드 — 송장 회신 도착 줄", () => {
  it("미처리 회신이 있으면 송장회신 버튼 옆에 「회신 도착 · N건 · HH:MM」", async () => {
    campaignList.current = [
      { ...baseCampaign, invoiceReply: { count: 12, receivedAt: "2026-10-06T05:05:00.000Z" } },
    ];
    render(<OrderDashboard />);

    const line = await screen.findByTestId("invoice-reply-line");
    expect(line).toHaveTextContent("회신 도착 · 12건 · 14:05");
    // 송장회신 버튼은 그대로 있다(1단계는 감지만).
    expect(screen.getByRole("button", { name: /송장회신/ })).toBeInTheDocument();
  });

  it("회신이 없으면(null) 줄이 없다", async () => {
    campaignList.current = [{ ...baseCampaign, invoiceReply: null }];
    render(<OrderDashboard />);

    await screen.findByRole("button", { name: /송장회신/ });
    expect(screen.queryByTestId("invoice-reply-line")).not.toBeInTheDocument();
  });
});
