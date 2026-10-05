// @vitest-environment jsdom
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

/**
 * 체크리스트 토글은 status 가 전이하지 않아도 **매번** 상위에 알린다.
 * 카드의 진행 막대·다음 항목은 행의 `checklistSummary` 를 읽고, 계산서 발행일·그룹 형제
 * 항목도 토글로 바뀐다 — 종전엔 단계가 넘어갈 때만 알려서 그 밖의 토글은 카드가 낡았다.
 */
const ITEM = {
  id: "item-1",
  label: "콘텐츠 검수",
  status: "ACTIVE",
  sortOrder: 0,
  isChecked: false,
  isRequired: true,
};

function summary(checkedCount: number) {
  return {
    status: "ACTIVE",
    checkedCount,
    totalCount: 2,
    requiredCheckedCount: checkedCount,
    requiredTotalCount: 2,
    nextItemLabel: "정산 전 최종 점검",
    isComplete: false,
  };
}

describe("CampaignSidePanel 체크리스트 토글 → 상위 통지", () => {
  let checked = false;
  let failRowRead = false;

  beforeEach(() => {
    vi.clearAllMocks();
    checked = false;
    failRowRead = false;
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      if (url.includes("/api/campaign-checklist/items/item-1") && init?.method === "PATCH") {
        checked = true;
        // 단계 전이 없음 — 응답 status 가 캠페인의 현재 status 와 같다.
        return json({ item: { ...ITEM, isChecked: true }, campaignStatus: "ACTIVE", transitioned: false });
      }
      if (url.includes("/api/campaigns/camp-1/checklist")) {
        return json({
          status: "ACTIVE",
          summary: summary(checked ? 1 : 0),
          items: [{ ...ITEM, isChecked: checked }],
        });
      }
      if (url === "/api/campaigns/camp-1") {
        if (failRowRead) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
        return json({ ...baseCampaign, checklistSummary: summary(1) });
      }
      return json({});
    }) as typeof fetch;
  });

  it("단계가 그대로여도 다시 읽은 행을 상위에 넘긴다", async () => {
    const onCampaignUpdated = vi.fn();
    renderPanel(baseCampaign, { onCampaignUpdated });

    fireEvent.click(await screen.findByRole("checkbox", { name: "콘텐츠 검수" }));

    await waitFor(() => expect(onCampaignUpdated).toHaveBeenCalledTimes(1));
    expect(onCampaignUpdated.mock.calls[0][0]).toMatchObject({
      id: "camp-1",
      status: "ACTIVE",
      checklistSummary: { checkedCount: 1 },
    });
  });

  it("행 재조회가 실패해도 체크리스트 스냅샷으로 접어 알린다", async () => {
    failRowRead = true;
    const onCampaignUpdated = vi.fn();
    renderPanel(baseCampaign, { onCampaignUpdated });

    fireEvent.click(await screen.findByRole("checkbox", { name: "콘텐츠 검수" }));

    await waitFor(() => expect(onCampaignUpdated).toHaveBeenCalledTimes(1));
    expect(onCampaignUpdated.mock.calls[0][0]).toMatchObject({
      id: "camp-1",
      checklistSummary: { checkedCount: 1 },
    });
  });
});
