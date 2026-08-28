import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import type { ApiCallLogRow, AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const baseCampaign: CampaignRow = {
  id: "camp-1",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: "테스트 딜 테스트 셀러",
  salesCode: null,
  dealName: "테스트 딜",
  partnerName: "테스트 파트너",
  sellerName: "테스트 셀러",
  snsType: "INSTAGRAM",
  snsHandle: "@test_seller",
  startDate: "2026-01-01",
  endDate: "2026-06-30",
  salesChannel: "OWN_MALL",
  baseNaverLink: "https://smartstore.naver.com/test",
  generatedTrackingLink: "https://link.test/abc",
  actualSales: 500000,
  operatingExpense: 10000,
  totalMarginRate: 30,
  sellerMarginRate: 10,
  netMarginRate: 20,
  status: "ACTIVE",
  isManualMargin: false,
  assignedTo: null,
  updatedAt: "2026-05-01T00:00:00Z",
  followerHistory: [{ date: "2026-04-01", followers: 10000 }],
  activityHistory: [],
  notes: [],
};

const logs: ApiCallLogRow[] = [
  {
    id: "log-1",
    provider: "INSTAGRAM",
    endpoint: "/metrics",
    statusCode: 200,
    success: true,
    calledAt: "2026-05-01T10:00:00Z",
    permissionScope: "read",
  },
];

const assets: AssetRow[] = [];
const storage: StorageSummary = {
  supabaseLimitBytes: 1073741824,
  supabaseWarningBytes: 858993459,
  supabaseEstimatedBytes: 0,
  googleDriveConnected: false,
  recentAssets: [],
};

function renderPanel(
  campaign: CampaignRow,
  props: Partial<React.ComponentProps<typeof CampaignSidePanel>> = {},
) {
  return render(
    <CampaignSidePanel
      campaign={campaign}
      logs={logs}
      assets={assets}
      storage={storage}
      open={true}
      onOpenChange={vi.fn()}
      onActualSalesSaved={vi.fn()}
      onCampaignUpdated={vi.fn()}
      {...props}
    />,
  );
}

describe("CampaignSidePanel workspace separation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/campaigns/camp-1/checklist")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "ACTIVE",
              summary: {
                checkedCount: 1,
                totalCount: 2,
                requiredCheckedCount: 1,
                requiredTotalCount: 1,
                nextItemLabel: "정산 전 최종 점검",
                isComplete: false,
              },
              items: [],
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as typeof fetch;
  });

  it("hides analytics-oriented history blocks in the PROGRESS workspace", async () => {
    renderPanel(baseCampaign, { workspaceFilter: "PROGRESS" });

    await waitFor(() => {
      expect(screen.getByText("현재 단계 작업, 매출 입력, 링크와 운영 메모를 관리합니다.")).toBeInTheDocument();
    });

    expect(screen.getByText("단계 체크리스트")).toBeInTheDocument();
    expect(screen.getAllByText("판매 진행 중").length).toBeGreaterThan(0);
    expect(screen.queryByText("연동 로그")).not.toBeInTheDocument();
    expect(screen.queryByText("정산 기초 정보")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미입금" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미지급" })).not.toBeInTheDocument();
  });

  it("shows settlement wait guidance without settlement processing controls in the PROGRESS workspace", async () => {
    renderPanel({ ...baseCampaign, status: "SETTLEMENT_WAIT" }, { workspaceFilter: "PROGRESS" });

    await waitFor(() => {
      expect(screen.getByText("정산 대기 기준")).toBeInTheDocument();
    });

    expect(screen.getByText("단계 체크리스트")).toBeInTheDocument();
    expect(screen.getAllByText("정산 대기").length).toBeGreaterThan(0);
    expect(screen.queryByText("세금계산서 발행일")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미입금" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "미지급" })).not.toBeInTheDocument();
  });

  it("keeps analytics-oriented history visible outside the PROGRESS workspace", async () => {
    renderPanel(baseCampaign, { workspaceFilter: "ALL" });

    await waitFor(() => {
      expect(screen.getByText("수수료, 링크, 팔로워 지표와 API 로그를 확인합니다.")).toBeInTheDocument();
    });

    expect(screen.getByText("단계 체크리스트")).toBeInTheDocument();
    expect(screen.getByText("연동 로그")).toBeInTheDocument();
  });
});
