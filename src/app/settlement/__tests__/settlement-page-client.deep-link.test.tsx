// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 주소로 캠페인 상세 열기 — `/settlement?campaign=<id>`.
 *
 * 홈 「오늘 처리할 일」의 「지연된 정산」 행(한 건일 때)이 이 주소로 온다(2026-10-18 오너 결정 — 빠른
 * 정산 창을 홈에서 빼고 정산 관리 상세가 그 일을 맡는다). id 는 아젠다 항목 id 이고, 그룹은 대표 멤버
 * id 다(`agenda-settlements.ts`). 상세 패널은 표의 월 필터와 무관하게 열린다 — 행은 월로 걸러지기
 * 전의 정산 목록(`data.campaigns`)에서 찾고, 없으면 그 한 건을 서버에서 읽는다.
 * 패널을 닫으면 주소에서 `campaign` 을 지운다 — 새로고침이 패널을 다시 열지 않게.
 */

const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: (...args: unknown[]) => toastWarning(...args),
  }),
}));

const replace = vi.fn();
const replaceState = vi.spyOn(window.history, "replaceState");
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  usePathname: () => "/settlement",
  useSearchParams: () => search,
}));

let panelProps: { campaign: CampaignRow | null; open: boolean; onOpenChange: (open: boolean) => void } | null = null;
vi.mock("@/components/crm/campaign-side-panel", () => ({
  CampaignSidePanel: (props: { campaign: CampaignRow | null; open: boolean; onOpenChange: (open: boolean) => void }) => {
    panelProps = props;
    return props.open && props.campaign ? <aside data-testid="panel">{props.campaign.id}</aside> : null;
  },
}));
vi.mock("@/components/crm/settlement-table", () => ({ SettlementTable: () => null }));
vi.mock("@/components/crm/settlement-completed-table", () => ({ SettlementCompletedTable: () => null }));

import { SettlementPageClient } from "../settlement-page-client";

function row(id: string): CampaignRow {
  return {
    id,
    status: "SETTLEMENT_IN_PROGRESS",
    dealName: `딜-${id}`,
    sellerName: "셀러",
    salesChannel: "SELLER_MALL",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    groupId: null,
  } as unknown as CampaignRow;
}

let campaignRequests: string[] = [];
let serverRows: Record<string, CampaignRow> = {};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports/settlement")) {
        return { ok: true, json: async () => ({ campaigns: [], summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0 } }) };
      }
      const match = url.match(/^\/api\/campaigns\/([^/?]+)$/);
      if (match) {
        campaignRequests.push(decodeURIComponent(match[1]));
        const found = serverRows[decodeURIComponent(match[1])];
        return found ? { ok: true, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

function initialData(campaigns: CampaignRow[]): DashboardData {
  return { campaigns, apiCallLogs: [], assets: [], storage: null } as unknown as DashboardData;
}

beforeEach(() => {
  replace.mockReset();
  replaceState.mockClear();
  toastWarning.mockReset();
  campaignRequests = [];
  serverRows = {};
  panelProps = null;
  search = new URLSearchParams();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("정산 페이지 — 주소로 캠페인 상세 열기", () => {
  it("campaign 이 정산 목록에 있으면 표의 월과 무관하게 그 상세를 연다(서버 재조회 없음)", async () => {
    search = new URLSearchParams("campaign=b");
    render(<SettlementPageClient initialData={initialData([row("a"), row("b")])} defaultMonth="2026-10" />);
    expect(await screen.findByTestId("panel")).toHaveTextContent("b");
    expect(campaignRequests).toEqual([]);
  });

  it("목록에 없으면 그 한 건을 서버에서 읽어 연다", async () => {
    search = new URLSearchParams("campaign=far");
    serverRows = { far: row("far") };
    render(<SettlementPageClient initialData={initialData([row("a")])} defaultMonth="2026-10" />);
    expect(await screen.findByTestId("panel")).toHaveTextContent("far");
    expect(campaignRequests).toEqual(["far"]);
  });

  it("서버에도 없으면 알리고 주소에서 campaign 을 지운다(빈 패널을 띄우지 않는다)", async () => {
    search = new URLSearchParams("month=2026-10&campaign=gone");
    render(<SettlementPageClient initialData={initialData([row("a")])} defaultMonth="2026-10" />);
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settlement?month=2026-10");
  });

  it("패널을 닫으면 주소에서 campaign 만 지운다 — 새로고침이 다시 열지 않게, 다른 필터는 둔다", async () => {
    search = new URLSearchParams("month=2026-09&campaign=b");
    render(<SettlementPageClient initialData={initialData([row("b")])} defaultMonth="2026-10" />);
    await screen.findByTestId("panel");
    act(() => panelProps!.onOpenChange(false));
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settlement?month=2026-09");
    // 서버 렌더를 다시 돌리는 라우터 이동은 쓰지 않는다(그 사이 새로고침하면 다시 열렸다).
    expect(replace).not.toHaveBeenCalled();
  });

  it("campaign 이 없으면 아무 것도 열지 않는다", async () => {
    render(<SettlementPageClient initialData={initialData([row("a")])} defaultMonth="2026-10" />);
    await waitFor(() => expect(panelProps).not.toBeNull());
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
