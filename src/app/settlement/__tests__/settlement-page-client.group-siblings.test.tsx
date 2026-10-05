// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";
import { buildSettlementPending } from "@/components/mobile/mobile-settlement-pending-sheet";

/**
 * ① 그룹 소속 캠페인을 저장하면 서버는 형제에도 반영하지만(정산 일정·플래그 = 그룹 스칼라,
 *    기간 = 팬아웃) 응답은 **수정한 1건**뿐이다 — 형제 행을 다시 읽어야 표가 새 값을 보인다.
 * ② 헤더 「입금 대기 / 지급 대기」는 모바일 정산 대기 시트와 같은 SSOT
 *    (`buildSettlementPending`)로 센다 — 자사몰의 공급사 지급 다리가 빠지면 안 된다.
 */

const toastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    warning: (...args: unknown[]) => toastWarning(...args),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/settlement",
  useSearchParams: () => new URLSearchParams(),
}));

let notifyUpdated: ((rows: CampaignRow[]) => void) | null = null;
vi.mock("@/components/crm/campaign-side-panel", () => ({
  CampaignSidePanel: ({
    onCampaignUpdated,
  }: {
    onCampaignUpdated: (campaign: CampaignRow) => void;
  }) => {
    notifyUpdated = (rows) => rows.forEach((row) => onCampaignUpdated(row));
    return null;
  },
}));

// 표는 이 테스트의 관심 밖이다 — 받은 행의 입금 예정일만 드러내 「형제가 새 값을 받았는가」를 본다.
vi.mock("@/components/crm/settlement-table", () => ({
  SettlementTable: ({ campaigns }: { campaigns: CampaignRow[] }) => (
    <ul>
      {campaigns.map((c) => (
        <li key={c.id} data-testid={`row-${c.id}`}>
          {c.expectedDepositDate ?? "none"}
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("@/components/crm/settlement-completed-table", () => ({
  SettlementCompletedTable: () => null,
}));

import { SettlementPageClient } from "../settlement-page-client";

function row(id: string, over: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id,
    status: "SETTLEMENT_IN_PROGRESS",
    dealName: `딜-${id}`,
    sellerName: "셀러",
    salesChannel: "SELLER_MALL",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    groupId: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...over,
  } as unknown as CampaignRow;
}

let campaignRequests: string[] = [];
let serverRows: Record<string, CampaignRow> = {};
let failCampaignReads = false;

function stubFetch(reportIds: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports/settlement")) {
        return {
          ok: true,
          json: async () => ({
            campaigns: reportIds.map((id) => ({ id })),
            summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0 },
          }),
        };
      }
      const match = url.match(/^\/api\/campaigns\/([^/?]+)$/);
      if (match) {
        campaignRequests.push(match[1]);
        if (failCampaignReads) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => serverRows[match[1]] };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

function initialData(campaigns: CampaignRow[]): DashboardData {
  return { campaigns, apiCallLogs: [], assets: [], storage: null } as unknown as DashboardData;
}

beforeEach(() => {
  campaignRequests = [];
  serverRows = {};
  failCampaignReads = false;
  notifyUpdated = null;
  toastWarning.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("정산 페이지 — 그룹 형제 행 재조회", () => {
  const GROUPED = [
    row("a", { groupId: "g1" }),
    row("b", { groupId: "g1" }),
    row("c", { groupId: "g1" }),
    row("solo"),
  ];

  it("그룹 멤버 1건을 저장하면 나머지 멤버 전원을 다시 읽어 새 값을 보인다", async () => {
    stubFetch(["a", "b", "c", "solo"]);
    serverRows = {
      b: row("b", { groupId: "g1", expectedDepositDate: "2026-09-10" }),
      c: row("c", { groupId: "g1", expectedDepositDate: "2026-09-10" }),
    };
    render(<SettlementPageClient initialData={initialData(GROUPED)} defaultMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId("row-b")).toHaveTextContent("none"));

    await act(async () => {
      notifyUpdated!([row("a", { groupId: "g1", expectedDepositDate: "2026-09-10" })]);
    });

    await waitFor(() => expect(screen.getByTestId("row-b")).toHaveTextContent("2026-09-10"));
    expect(screen.getByTestId("row-c")).toHaveTextContent("2026-09-10");
    expect(screen.getByTestId("row-solo")).toHaveTextContent("none");
    expect([...campaignRequests].sort()).toEqual(["b", "c"]);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("무그룹 저장과 한 틱 팬아웃(전원 도착)은 행 재조회를 만들지 않는다", async () => {
    stubFetch(["a", "b", "c", "solo"]);
    render(<SettlementPageClient initialData={initialData(GROUPED)} defaultMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId("row-a")).toBeInTheDocument());

    await act(async () => {
      notifyUpdated!([row("solo", { expectedDepositDate: "2026-09-01" })]);
    });
    await act(async () => {
      notifyUpdated!(GROUPED.slice(0, 3));
    });

    expect(campaignRequests).toEqual([]);
  });

  it("형제 재조회가 실패하면 알린다 — 조용히 낡은 채 두지 않는다", async () => {
    stubFetch(["a", "b", "c", "solo"]);
    failCampaignReads = true;
    render(<SettlementPageClient initialData={initialData(GROUPED)} defaultMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId("row-a")).toBeInTheDocument());

    await act(async () => {
      notifyUpdated!([row("a", { groupId: "g1" })]);
    });

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
  });
});

describe("정산 페이지 — 헤더 대기 합계는 슬롯 SSOT 와 같다", () => {
  it("자사몰의 공급사 지급 다리가 「지급 대기」에 들어간다", async () => {
    const campaigns = [
      // 자사몰 = [공급사 지급, 셀러 지급] 두 다리. 셀러 지급은 끝났고 공급사 지급만 남았다.
      row("own", {
        salesChannel: "OWN_MALL",
        actualSales: 1_000_000,
        sellerExpense: 100_000,
        settlementGoodsCost: 600_000,
        isPayoutCompleted: true,
        isSupplierPayoutCompleted: false,
      }),
      row("seller-mall", {
        salesChannel: "SELLER_MALL",
        actualSales: 2_000_000,
        settlementSales: 300_000,
        sellerExpense: 50_000,
        settlementGoodsCost: 1_200_000,
      }),
    ];
    stubFetch(["own", "seller-mall"]);
    const expected = buildSettlementPending(campaigns, "2026-08-10");
    // 픽스처가 실제로 공급사 다리를 만든다(양성 대조) — 옛 식(미지급 × sellerExpense)과 값이 갈려야 한다.
    const legacyPayout = campaigns
      .filter((c) => !c.isPayoutCompleted)
      .reduce((sum, c) => sum + Number(c.sellerExpense ?? 0), 0);
    expect(expected.payout.total).not.toBe(legacyPayout);
    expect(expected.payout.total).toBeGreaterThan(0);

    render(<SettlementPageClient initialData={initialData(campaigns)} defaultMonth="2026-08" />);

    const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
    await waitFor(() =>
      expect(screen.getByText("지급 대기:").parentElement).toHaveTextContent(
        won(expected.payout.total),
      ),
    );
    expect(screen.getByText("입금 대기:").parentElement).toHaveTextContent(
      won(expected.deposit.total),
    );
  });
});
