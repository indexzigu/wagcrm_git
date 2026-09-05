// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 정산 리포트는 **행이 아니라 현재 필터**로 조회하는 화면 전체 값인데, 상위 콜백
 * (`onCampaignUpdated`)은 **행 하나**를 넘기는 계약이다(`lib/campaign-row-refresh`).
 * 그래서 그룹 묶기·합류·제외처럼 한 조작이 여러 행을 바꾸면 콜백이 같은 틱 안에서
 * 행 수만큼 불리고, 종전에는 그때마다 리포트를 다시 불러 **같은 응답을 건수만큼**
 * 받았다(T-096). 결과가 같아 화면은 멀쩡하므로 이 회귀는 조회 횟수로만 잡힌다.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/settlement",
  useSearchParams: () => new URLSearchParams(),
}));

// 팬아웃을 재현하는 자리. 실제 패널은 그룹 API·시트까지 끌고 오는데 이 테스트가 보는
// 계약은 "상위 콜백이 연달아 불리면 리포트가 몇 번 나가나" 하나라 콜백만 노출한다.
let fanOutUpdatedRows: ((rows: CampaignRow[]) => void) | null = null;
vi.mock("@/components/crm/campaign-side-panel", () => ({
  CampaignSidePanel: ({
    onCampaignUpdated,
  }: {
    onCampaignUpdated: (campaign: CampaignRow) => void;
  }) => {
    fanOutUpdatedRows = (rows) => rows.forEach((row) => onCampaignUpdated(row));
    return null;
  },
}));

import { SettlementPageClient } from "../settlement-page-client";

/** 페이지가 실제로 읽는 필드만 채운다(목록 매핑·선택 동기화만 탄다). */
function campaignRow(id: string): CampaignRow {
  return { id, status: "SETTLEMENT_IN_PROGRESS" } as unknown as CampaignRow;
}

const REPORT = {
  campaigns: [],
  summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0 },
};

const INITIAL_DATA = {
  campaigns: [campaignRow("c1"), campaignRow("c2"), campaignRow("c3")],
  apiCallLogs: [],
  assets: [],
  storage: null,
} as unknown as DashboardData;

let reportRequests: string[] = [];

beforeEach(() => {
  reportRequests = [];
  fanOutUpdatedRows = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports/settlement")) {
        reportRequests.push(url);
        return { ok: true, json: async () => REPORT };
      }
      // 세무 배지 등 보조 조회 — 이 테스트의 관심 밖이라 빈 객체로 만족시킨다.
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("정산 페이지 리포트 재조회", () => {
  it("한 번에 바뀐 캠페인 3건을 흘려보내도 리포트는 1회만 조회한다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);

    // 최초 마운트 1회를 기준선으로 잡고 시작한다.
    await waitFor(() => expect(reportRequests).toHaveLength(1));
    expect(fanOutUpdatedRows).not.toBeNull();

    await act(async () => {
      fanOutUpdatedRows!([campaignRow("c1"), campaignRow("c2"), campaignRow("c3")]);
    });

    expect(reportRequests).toHaveLength(2);
  });

  it("다음 조작은 다시 조회한다 — 묶는 것은 한 틱이지 갱신 자체가 아니다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await waitFor(() => expect(reportRequests).toHaveLength(1));

    await act(async () => {
      fanOutUpdatedRows!([campaignRow("c1"), campaignRow("c2")]);
    });
    await act(async () => {
      fanOutUpdatedRows!([campaignRow("c3")]);
    });

    expect(reportRequests).toHaveLength(3);
  });
});
