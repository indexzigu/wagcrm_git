// 「신고자료출력」(원천징수 도우미) 트리거 게이트 계약 (2026-08-05).
//
// 세금계산서 도우미 쪽 자매 테스트(campaign-side-panel-tax-invoice-trigger.test.tsx)는
// "채널이 셀러몰일 때만" 버튼이 뜨는 것을 고정한다. 원천징수 도우미는 그 게이트를
// 그대로 베끼면 안 된다 — 개인 셀러는 세금계산서를 주고받지 않고 원천징수 대상이며,
// 그 의무는 셀러 수수료를 지급하는 모든 채널에서 발생한다(`buildWithholdingReport`가
// 채널로 걸러내지 않는 것과 동일). 이 테스트는 개인 셀러면 우리몰·브랜드몰·셀러몰
// 어디서든 버튼이 뜨고, 사업자 셀러면(세금계산서 쪽 버튼과 자리가 겹치므로) 원천징수
// 버튼이 뜨지 않음을 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import type { ApiCallLogRow, AssetRow, CampaignRow, StorageSummary, SalesChannel } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
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

function makeCampaign(
  salesChannel: SalesChannel,
  sellerTaxType: "INDIVIDUAL" | "BUSINESS",
): CampaignRow {
  const isIndividual = sellerTaxType === "INDIVIDUAL";
  return {
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
    salesChannel,
    baseNaverLink: "https://smartstore.naver.com/test",
    generatedTrackingLink: "https://link.test/abc",
    actualSales: 13_200_000,
    sellerExpense: 2_200_000,
    settlementSales: 6_600_000,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-05-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    sellerTaxType,
    ...(isIndividual
      ? {
          sellerRealName: "김철수",
          sellerResidentNumber: "900101-9234567",
          sellerCompanyBusinessNumber: null,
        }
      : {
          sellerCompanyName: "○○커머스",
          sellerCompanyCeoName: "대표A",
          sellerCompanyBusinessNumber: "123-45-67890",
        }),
  } as CampaignRow;
}

const logs: ApiCallLogRow[] = [];
const assets: AssetRow[] = [];
const storage: StorageSummary = {
  supabaseLimitBytes: 1073741824,
  supabaseWarningBytes: 858993459,
  supabaseEstimatedBytes: 0,
  googleDriveConnected: false,
  recentAssets: [],
};

function renderPanel(campaign: CampaignRow) {
  return render(
    <CampaignSidePanel
      campaign={campaign}
      logs={logs}
      assets={assets}
      storage={storage}
      open
      onOpenChange={vi.fn()}
      onActualSalesSaved={vi.fn()}
      onCampaignUpdated={vi.fn()}
      settlementWorkspace
    />,
  );
}

describe("SellerSettlementInfo 「신고자료출력」(원천징수) 트리거 — 개인 셀러는 채널 무관", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/checklist")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as typeof fetch;
  });

  it("우리몰 개인 셀러 — 버튼이 보인다(원천징수는 채널을 가리지 않는다)", async () => {
    renderPanel(makeCampaign("OWN_MALL", "INDIVIDUAL"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /신고자료출력/ })).toBeInTheDocument();
    });
  });

  it("브랜드몰 개인 셀러 — 버튼이 보인다(원천징수는 채널을 가리지 않는다)", async () => {
    renderPanel(makeCampaign("BRAND_MALL", "INDIVIDUAL"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /신고자료출력/ })).toBeInTheDocument();
    });
  });

  it("셀러몰 개인 셀러 — 버튼이 보인다", async () => {
    renderPanel(makeCampaign("SELLER_MALL", "INDIVIDUAL"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /신고자료출력/ })).toBeInTheDocument();
    });
  });

  it("우리몰 사업자 셀러 — 세금계산서 발행 의무도 없고 원천징수 대상도 아니므로 버튼이 사라진다", async () => {
    renderPanel(makeCampaign("OWN_MALL", "BUSINESS"));
    await waitFor(() => {
      expect(screen.getByText("정산 정보")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /신고자료출력/ })).not.toBeInTheDocument();
  });

  it("셀러몰 사업자 셀러 — 세금계산서 도우미 버튼이 뜬다(원천징수 도우미가 아니다)", async () => {
    renderPanel(makeCampaign("SELLER_MALL", "BUSINESS"));
    const trigger = await screen.findByRole("button", { name: /신고자료출력/ });
    expect(trigger).toBeInTheDocument();
    // 정확히 하나만 떠야 한다 — 개인/사업자 두 도우미가 동시에 뜨면 오너가 어느
    // 자료가 맞는지 알 수 없다.
    expect(screen.getAllByRole("button", { name: /신고자료출력/ })).toHaveLength(1);
  });
});
