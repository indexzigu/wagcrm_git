// @vitest-environment jsdom
// T-313 Part A — side panel date inputs for a campaign whose period is not set yet ("기간 미정").
// The stored dates are placeholders: the inputs start empty (「미정」), and picking only one date
// must not save it (the other date would stay a placeholder posing as a real date). Once both are
// picked, start and end are saved in ONE request. Harness copied from campaign-side-panel-workspace.test.tsx.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  periodUnset: false,
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
      onCampaignUpdated={vi.fn()}
      {...props}
    />,
  );
}


const unsetCampaign: CampaignRow = {
  ...baseCampaign,
  status: "PREPARATION",
  startDate: "2026-11-17",
  endDate: "2026-11-17",
  periodUnset: true,
};

function campaignPatchCalls() {
  return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([url, init]) => url === "/api/campaigns/camp-1" && (init as RequestInit | undefined)?.method === "PATCH",
  );
}

function pickDate(cellLabel: string, value: string) {
  const cell = screen.getByText(cellLabel).parentElement!;
  fireEvent.click(cell.querySelector("button")!);
  const input = cell.querySelector('input[type="date"]') as HTMLInputElement;
  expect(input.value).toBe("");
  fireEvent.blur(input, { target: { value } });
}

describe("CampaignSidePanel — 기간 미정 날짜 입력(T-313)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ...unsetCampaign, periodUnset: false }) }),
    ) as typeof fetch;
  });

  it("자리표시 날짜 대신 「미정」을 보여주고, 두 날짜를 다 고르면 한 요청으로 저장한다", async () => {
    renderPanel(unsetCampaign);

    expect(screen.queryByText("2026.11.17")).toBeNull();
    expect(screen.getAllByText("미정").length).toBeGreaterThanOrEqual(2);

    pickDate("시작일", "2026-11-20");
    // One date alone is held on screen, not saved.
    expect(campaignPatchCalls()).toHaveLength(0);
    expect(screen.getByText("2026.11.20")).toBeInTheDocument();

    pickDate("판매종료일", "2026-11-27");
    await waitFor(() => expect(campaignPatchCalls()).toHaveLength(1));
    const body = JSON.parse(String((campaignPatchCalls()[0][1] as RequestInit).body));
    expect(body).toEqual({ startDate: "2026-11-20", endDate: "2026-11-27" });
  });
});
