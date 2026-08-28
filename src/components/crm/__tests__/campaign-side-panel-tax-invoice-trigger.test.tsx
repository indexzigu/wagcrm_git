// @vitest-environment jsdom
// 「신고자료출력」 트리거 채널 게이트 계약 (2026-08-04).
//
// SellerSettlementInfo(campaign-side-panel.tsx)는 exported 되지 않으므로 이 채널
// 게이트는 CampaignSidePanel 전체를 렌더해서 검증한다 — 이 다이얼로그를 여는 버튼이
// "우리가 셀러에게 세금계산서를 발행하는" 채널(셀러몰)에서만 보여야 한다는 계약을
// tax-invoice-helper-dialog.test.tsx 하나로는 고정할 수 없다(그 파일은 다이얼로그
// 내부 콘텐츠만 다룬다 — 트리거 자체는 이 파일의 부모 컴포넌트가 그린다).
//
// ⛔ 정정 배경: 트리거는 원래 `!isIndividualSeller(campaign)` 하나로만 게이트됐다.
// 우리몰은 우리가 셀러에게 발행하는 계산서가 아예 없고, 브랜드몰의 발행 상대는
// 셀러가 아니라 공급사다(스펙 「⛔ 채널별 세금계산서 거래 구조」, 오너 확정
// 2026-08-03/04) — 그런데도 사업자 셀러이기만 하면 두 채널 모두에서 버튼이 뜨고
// 있었다. 이 테스트는 그 버튼이 셀러몰에서만 뜨고 우리몰·브랜드몰에서는 사라짐을
// 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function makeCampaign(salesChannel: SalesChannel): CampaignRow {
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
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "123-45-67890",
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

describe("SellerSettlementInfo 「신고자료출력」 트리거 — 채널 게이트", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/checklist")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as typeof fetch;
  });

  it("셀러몰 캠페인에서는 버튼이 보인다(우리가 셀러에게 발행하는 유일한 채널)", async () => {
    renderPanel(makeCampaign("SELLER_MALL"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /신고자료출력/ })).toBeInTheDocument();
    });
  });

  it("우리몰 캠페인에서는 버튼이 사라진다(우리가 발행하는 계산서 자체가 없음)", async () => {
    renderPanel(makeCampaign("OWN_MALL"));
    await waitFor(() => {
      expect(screen.getByText("정산 정보")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /신고자료출력/ })).not.toBeInTheDocument();
  });

  it("브랜드몰 캠페인에서는 버튼이 사라진다(발행 상대가 공급사, 셀러가 아님)", async () => {
    renderPanel(makeCampaign("BRAND_MALL"));
    await waitFor(() => {
      expect(screen.getByText("정산 정보")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /신고자료출력/ })).not.toBeInTheDocument();
  });
});

describe("SellerSettlementInfo 「신고자료출력」 — 정산 그룹 소속이면 그룹 상세를 조회해 합산 금액을 보여준다(Finding 2)", () => {
  // 다이얼로그를 열 때 `fetchGroupDetail`(→ GET /api/campaign-groups/:id)을 태워
  // 형제 멤버의 매출·수수료를 받아오는 배선(campaign-side-panel.tsx의 useEffect)을
  // 고정한다. code-reviewer 교차검증에서 지적된 커버리지 공백(다이얼로그 컴포넌트
  // 단위 테스트만 있고, 이 fetch 배선 자체는 테스트가 없었다)을 메운다.
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/campaign-groups/g1")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "g1",
              sellerId: "seller-1",
              sellerName: "테스트 셀러",
              name: null,
              startDate: null,
              endDate: null,
              memberCount: 2,
              memberCampaignIds: ["camp-1", "camp-2"],
              isDepositReceived: false,
              isPayoutCompleted: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              members: [
                {
                  campaignId: "camp-1",
                  dealName: "테스트 딜",
                  campaignName: "테스트 딜 테스트 셀러",
                  status: "SETTLEMENT_IN_PROGRESS",
                  startDate: "2026-01-01",
                  endDate: "2026-06-30",
                  roundNumber: null,
                  salesChannel: "SELLER_MALL",
                  actualSales: 13_200_000,
                  sellerExpense: 2_200_000,
                },
                {
                  campaignId: "camp-2",
                  dealName: "테스트 딜2",
                  campaignName: "테스트 딜2 테스트 셀러",
                  status: "SETTLEMENT_IN_PROGRESS",
                  startDate: "2026-01-01",
                  endDate: "2026-06-30",
                  roundNumber: null,
                  salesChannel: "SELLER_MALL",
                  actualSales: 5_500_000,
                  sellerExpense: 1_100_000,
                },
              ],
            }),
        });
      }
      if (url.includes("/checklist")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as typeof fetch;
  });

  it("다이얼로그를 열면 그룹 상세를 조회하고, 멤버 전원 합산 금액과 「그룹 전체」 안내를 보여준다", async () => {
    const campaign = { ...makeCampaign("SELLER_MALL"), groupId: "g1" } as CampaignRow;
    renderPanel(campaign);

    const trigger = await screen.findByRole("button", { name: /신고자료출력/ });
    fireEvent.click(trigger);

    // 그룹 상세 조회 fetch 가 실제로 나갔는지 확인 — 배선 자체가 이 테스트의 핵심이다.
    await waitFor(() => {
      expect(
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
          String(call[0]).includes("/api/campaign-groups/g1"),
        ),
      ).toBe(true);
    });

    // (13,200,000-2,200,000)+(5,500,000-1,100,000)=15,400,000 → 공급가 14,000,000
    await waitFor(() => {
      expect(screen.getAllByText("14,000,000").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText(/그룹 전체.*합산/)).toBeInTheDocument();
    // 캠페인 1건(camp-1) 단독 몫(10,000,000)이 아니라는 회귀 방지.
    expect(screen.queryByText("10,000,000")).not.toBeInTheDocument();
  });
});
