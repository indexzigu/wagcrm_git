// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CampaignRow } from "@/lib/crm-types";

// Polyfill window.matchMedia for jsdom (used by CampaignSidePanel's useDesktop hook)
beforeAll(() => {
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
});

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// CampaignSidePanel — 상태 스테퍼: 인접 단계만 선택 가능, 변경은 저장된다
// ---------------------------------------------------------------------------

// We test the InlineStatusEdit behavior indirectly through CampaignSidePanel.
// Since CampaignSidePanel is very large and has many dependencies, we test
// the core blocking logic via the InlineStatusEdit sub-component behavior.

describe("CampaignSidePanel — 상태 스테퍼 인접 단계 규칙", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CampaignSidePanel blocks non-adjacent PROPOSAL selection", async () => {
    // Mock fetch for the various API calls CampaignSidePanel makes
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([]),
    });
    global.fetch = fetchMock;

    // Dynamically import to avoid issues with the large component
    const { CampaignSidePanel } = await import("../campaign-side-panel");

    const campaign: CampaignRow = {
      id: "camp-test-1",
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: "테스트 딜 테스트 셀러",
      dealName: "테스트 딜",
      partnerName: "테스트 파트너",
      sellerName: "테스트 셀러",
      snsType: "INSTAGRAM",
      snsHandle: "@test",
      startDate: "2026-01-15",
      endDate: "2026-12-31",
      salesChannel: "OWN_MALL",
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales: null,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      netMarginRate: 20,
      status: "ACTIVE",
      isManualMargin: false,
      assignedTo: null,
      updatedAt: "2026-01-01T00:00:00Z",
      followerHistory: [{ date: "2026-01-01", followers: 50000 }],
      activityHistory: [],
      notes: [],
    } as CampaignRow;

    render(
      <CampaignSidePanel
        campaign={campaign}
        logs={[]}
        assets={[]}
        storage={{ supabaseLimitBytes: 0, supabaseWarningBytes: 0, supabaseEstimatedBytes: 0, googleDriveConnected: false, recentAssets: [] }}
        open={true}
        onOpenChange={vi.fn()}
        onCampaignUpdated={vi.fn()}
      />,
    );

    // The StatusStepper renders buttons for each status step.
    // For ACTIVE (index 2), PROPOSAL (index 0) is NOT adjacent (distance = 2), so it should be disabled.
    const proposalButton = screen.getByRole("button", { name: /셀러 제안 중 \(1\/7\)/ });
    expect(proposalButton).toBeDisabled();
  });

  it("CampaignSidePanel allows adjacent status change and saves it", async () => {
    // Mock fetch for the various API calls
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes("/api/campaigns/") && options?.method === "PATCH") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: "camp-test-1",
            status: "CLOSED",
            dealId: "deal-1",
            sellerId: "seller-1",
            dealName: "테스트 딜",
            partnerName: "테스트 파트너",
            sellerName: "테스트 셀러",
            snsType: "INSTAGRAM",
            snsHandle: "@test",
            startDate: "2026-01-15",
            endDate: "2026-12-31",
            salesChannel: "OWN_MALL",
            baseNaverLink: "",
            generatedTrackingLink: "",
            actualSales: null,
            totalMarginRate: 30,
            sellerMarginRate: 10,
            netMarginRate: 20,
            isManualMargin: false,
            assignedTo: null,
            updatedAt: "2026-01-01T00:00:00Z",
            followerHistory: [],
            activityHistory: [],
            notes: [],
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ([]),
      });
    });
    global.fetch = fetchMock;

    const { CampaignSidePanel } = await import("../campaign-side-panel");

    const campaign: CampaignRow = {
      id: "camp-test-1",
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: "테스트 딜 테스트 셀러",
      dealName: "테스트 딜",
      partnerName: "테스트 파트너",
      sellerName: "테스트 셀러",
      snsType: "INSTAGRAM",
      snsHandle: "@test",
      startDate: "2026-01-15",
      endDate: "2026-12-31",
      salesChannel: "OWN_MALL",
      baseNaverLink: "",
      generatedTrackingLink: "",
      actualSales: null,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      netMarginRate: 20,
      status: "ACTIVE",
      isManualMargin: false,
      assignedTo: null,
      updatedAt: "2026-01-01T00:00:00Z",
      followerHistory: [{ date: "2026-01-01", followers: 50000 }],
      activityHistory: [],
      notes: [],
    } as CampaignRow;

    const onCampaignUpdated = vi.fn();

    render(
      <CampaignSidePanel
        campaign={campaign}
        logs={[]}
        assets={[]}
        storage={{ supabaseLimitBytes: 0, supabaseWarningBytes: 0, supabaseEstimatedBytes: 0, googleDriveConnected: false, recentAssets: [] }}
        open={true}
        onOpenChange={vi.fn()}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );

    // The StatusStepper renders buttons. For ACTIVE (index 2), CLOSED (index 3) is adjacent forward.
    const closedButton = screen.getByRole("button", { name: /판매 마감 \(4\/7\)/ });
    expect(closedButton).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(closedButton);

    // Should have called the API
    await waitFor(() => {
      expect(onCampaignUpdated).toHaveBeenCalled();
    });
  });
});
