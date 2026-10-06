// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

// T-235 — 거래처 양식(template)이 없는 발주 캠페인에서 「송장회신」을 누르면, 서버(fetch-emails)는
// 400 으로 거절한다. DB 가 양식을 비울 수 있는데(`OrderCampaign.template String?`) 화면 타입이
// `string` 이라 가드 없이 보내던 드리프트(API Drift Detector 시험 2026-10-06). 여기서 보는 것:
// 양식이 없으면 ① fetch-emails 요청이 나가지 않고 ② 이유·다음 행동을 담은 오류 토스트가 뜬다.
// 양식이 있으면 종전대로 요청이 나간다(대조군).
// ⚠️ 외부 호출은 전부 fetch 목이다 — 실제로 나가는 요청은 없다.

const campaignList = vi.hoisted(() => ({ current: [] as unknown[] }));
const notifyMock = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/toast", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  ERROR_TOAST_DURATION: Number.POSITIVE_INFINITY,
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
  invoiceReply: null,
};

function fetchEmailCalls(): unknown[][] {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter(([url]) => typeof url === "string" && url.includes("/order-converter/api/fetch-emails"));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ logs: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("주문 관리 카드 — 거래처 양식 없는 캠페인의 송장회신 (T-235)", () => {
  it("양식이 null 이면 fetch-emails 를 부르지 않고 이유·다음 행동을 오류 토스트로 알린다", async () => {
    campaignList.current = [{ ...baseCampaign, template: null }];
    render(<OrderDashboard />);

    const button = await screen.findByRole("button", { name: /송장회신/ });
    fireEvent.click(button);

    expect(fetchEmailCalls()).toHaveLength(0);
    const errorCalls = notifyMock.mock.calls.filter(([, type]) => type === "error");
    expect(errorCalls).toHaveLength(1);
    const message = String(errorCalls[0][0]);
    expect(message).toContain("거래처 양식");
    // 다음 행동의 진입점 이름은 카드 ⋮ 메뉴 「설정」·모달 제목 「캠페인 설정」과 같아야 한다(한 동작 한 라벨).
    expect(message).toContain("캠페인 설정");
    // UI 문구 규칙: 토스트에 장식용 줄표(—) 없음.
    expect(message).not.toContain("—");
    // 「확인 중」 진행 토스트는 뜨지 않는다(요청을 안 보냈으니).
    expect(notifyMock.mock.calls.some(([m]) => String(m).includes("확인 중"))).toBe(false);
  });

  it("대조군: 양식이 있으면 종전대로 fetch-emails 요청이 나간다", async () => {
    campaignList.current = [{ ...baseCampaign, template: "brand" }];
    render(<OrderDashboard />);

    const button = await screen.findByRole("button", { name: /송장회신/ });
    fireEvent.click(button);

    await vi.waitFor(() => expect(fetchEmailCalls()).toHaveLength(1));
    const body = JSON.parse((fetchEmailCalls()[0][1] as { body: string }).body);
    expect(body.template).toBe("brand");
    expect(notifyMock.mock.calls.some(([, type]) => type === "error" && true)).toBe(false);
  });
});
