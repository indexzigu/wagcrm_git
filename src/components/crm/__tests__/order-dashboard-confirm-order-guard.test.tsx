// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

// 「주문확인」은 스트림 라우트(execute/stream?action=download)를 열고, 그 라우트가 네이버
// 발주확인을 실행한다. 연타하면 스트림이 두 개 열려 발주확인이 두 번 돈다 — 송장회신·송장등록에
// 걸린 in-flight 가드(busyActions)가 이 핸들러에만 빠져 있었다. 여기서 보는 것:
// ① 첫 스트림이 끝나기 전 두 번째 클릭은 요청을 내지 않는다(같은 틱 연속 호출 포함)
// ② 진행 중엔 버튼이 잠기고, 끝나면 풀린다
// ③ 스트림이 100% 없이 끝나도 진행률 표시가 남지 않는다.
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

const STREAM_PATH = "/execute/stream?action=download";

function streamCalls(): unknown[][] {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter(([url]) => typeof url === "string" && url.includes(STREAM_PATH));
}

// 스트림 응답을 테스트가 손으로 닫을 수 있게 한다 — 닫기 전까지 첫 실행이 in-flight 로 남는다.
let releaseStream: (() => void) | null = null;

beforeEach(() => {
  releaseStream = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (typeof url === "string" && url.includes(STREAM_PATH)) {
        let finished = false;
        let wake: (() => void) | null = null;
        releaseStream = () => {
          finished = true;
          wake?.();
        };
        const reader = {
          read: () =>
            finished
              ? Promise.resolve({ done: true, value: undefined })
              : new Promise<{ done: boolean; value: undefined }>((resolve) => {
                  wake = () => resolve({ done: true, value: undefined });
                }),
        };
        return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ logs: [] }) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("주문 관리 카드 — 주문확인 연타 가드", () => {
  it("첫 스트림이 끝나기 전 두 번째 클릭은 스트림을 열지 않고, 버튼은 잠긴다", async () => {
    campaignList.current = [{ ...baseCampaign }];
    render(<OrderDashboard />);

    const button = await screen.findByRole("button", { name: /주문확인/ });
    fireEvent.click(button);
    fireEvent.click(button);

    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    expect(button).toBeDisabled();

    await act(async () => {
      releaseStream?.();
    });
    await vi.waitFor(() => expect(button).not.toBeDisabled());
    expect(streamCalls()).toHaveLength(1);
  });

  it("같은 틱에 두 번 불려도(리렌더 전) 스트림은 하나만 열린다", async () => {
    campaignList.current = [{ ...baseCampaign }];
    render(<OrderDashboard />);

    const button = await screen.findByRole("button", { name: /주문확인/ });
    // act 한 번 안에서 두 번 누르면 그 사이 리렌더가 없다 — state 만 보는 가드는 둘 다 통과한다.
    await act(async () => {
      button.click();
      button.click();
    });

    await vi.waitFor(() => expect(streamCalls()).toHaveLength(1));
    await act(async () => {
      releaseStream?.();
    });
  });

  it("스트림이 100% 없이 끝나도 진행률 표시가 남지 않는다", async () => {
    campaignList.current = [{ ...baseCampaign }];
    render(<OrderDashboard />);

    fireEvent.click(await screen.findByRole("button", { name: /주문확인/ }));
    expect(await screen.findByText("스트림 연결 중...")).toBeTruthy();

    await act(async () => {
      releaseStream?.();
    });
    await vi.waitFor(() => expect(screen.queryByText("스트림 연결 중...")).toBeNull());
  });
});
