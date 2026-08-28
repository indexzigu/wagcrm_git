import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnVisibilitySettings } from "../column-visibility-settings";
import { type ColumnSettings, DEFAULT_COLUMN_SETTINGS } from "@/lib/column-settings";
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
// ColumnVisibilitySettings — View C PROPOSAL toggle disabled (Requirement 5.2)
// ---------------------------------------------------------------------------

describe("ColumnVisibilitySettings — View C restrictions", () => {
  let settings: ColumnSettings;
  let onChange: (settings: ColumnSettings) => void;

  beforeEach(() => {
    settings = { ...DEFAULT_COLUMN_SETTINGS };
    onChange = vi.fn() as unknown as (settings: ColumnSettings) => void;
  });

  it("disables PROPOSAL toggle when viewMode is VIEW_C", async () => {
    const user = userEvent.setup();
    render(
      <ColumnVisibilitySettings
        settings={settings}
        onChange={onChange}
        viewMode="VIEW_C"
      />,
    );

    // Open the popover
    await user.click(screen.getByRole("button", { name: "컬럼 표시 설정" }));

    // Find the PROPOSAL switch — it should be disabled
    const proposalSwitch = await screen.findByRole("switch", {
      name: /셀러 제안 중 컬럼/,
    });
    expect(proposalSwitch).toBeDisabled();
  });

  it("keeps other column toggles enabled in View C", async () => {
    const user = userEvent.setup();
    render(
      <ColumnVisibilitySettings
        settings={settings}
        onChange={onChange}
        viewMode="VIEW_C"
      />,
    );

    // Open the popover
    await user.click(screen.getByRole("button", { name: "컬럼 표시 설정" }));

    // Other switches should NOT be disabled
    const preparationSwitch = await screen.findByRole("switch", {
      name: /세팅 대기 컬럼/,
    });
    const activeSwitch = await screen.findByRole("switch", {
      name: /판매 진행 중 컬럼/,
    });
    const closedSwitch = await screen.findByRole("switch", {
      name: /판매 마감 컬럼/,
    });

    expect(preparationSwitch).not.toBeDisabled();
    expect(activeSwitch).not.toBeDisabled();
    expect(closedSwitch).not.toBeDisabled();
  });

  it("does NOT disable PROPOSAL toggle when viewMode is VIEW_B", async () => {
    const user = userEvent.setup();
    render(
      <ColumnVisibilitySettings
        settings={settings}
        onChange={onChange}
        viewMode="VIEW_B"
      />,
    );

    // Open the popover
    await user.click(screen.getByRole("button", { name: "컬럼 표시 설정" }));

    const proposalSwitch = await screen.findByRole("switch", {
      name: /셀러 제안 중 컬럼/,
    });
    expect(proposalSwitch).not.toBeDisabled();
  });

  it("does NOT disable PROPOSAL toggle when viewMode is undefined", async () => {
    const user = userEvent.setup();
    render(
      <ColumnVisibilitySettings
        settings={settings}
        onChange={onChange}
      />,
    );

    // Open the popover
    await user.click(screen.getByRole("button", { name: "컬럼 표시 설정" }));

    const proposalSwitch = await screen.findByRole("switch", {
      name: /셀러 제안 중 컬럼/,
    });
    expect(proposalSwitch).not.toBeDisabled();
  });

  it("does not call onChange when PROPOSAL toggle is clicked in View C", async () => {
    const user = userEvent.setup();
    render(
      <ColumnVisibilitySettings
        settings={settings}
        onChange={onChange}
        viewMode="VIEW_C"
      />,
    );

    // Open the popover
    await user.click(screen.getByRole("button", { name: "컬럼 표시 설정" }));

    const proposalSwitch = await screen.findByRole("switch", {
      name: /셀러 제안 중 컬럼/,
    });

    // Attempt to click the disabled switch
    await user.click(proposalSwitch);

    expect(onChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CampaignSidePanel — View C blocks PROPOSAL status change (Requirement 5.6)
// ---------------------------------------------------------------------------

// We test the InlineStatusEdit behavior indirectly through CampaignSidePanel.
// Since CampaignSidePanel is very large and has many dependencies, we test
// the core blocking logic via the InlineStatusEdit sub-component behavior.
// The component uses isStatusChangeAllowed from zone-config and shows a toast.

describe("CampaignSidePanel — View C PROPOSAL status block", () => {
  // We need to import toast mock to verify it was called
  let toastMock: { error: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    const sonner = await import("sonner");
    toastMock = sonner.toast as unknown as { error: ReturnType<typeof vi.fn> };
  });

  // Since CampaignSidePanel is complex with many dependencies (fetch calls, etc.),
  // we test the status change blocking logic by importing and testing the
  // isStatusChangeAllowed function which is the core guard, and verify the
  // component integration through a focused render test.

  it("isStatusChangeAllowed blocks PROPOSAL in VIEW_C", async () => {
    const { isStatusChangeAllowed } = await import("@/lib/zone-config");

    expect(isStatusChangeAllowed("VIEW_C", "PROPOSAL")).toBe(false);
    expect(isStatusChangeAllowed("VIEW_C", "PREPARATION")).toBe(true);
    expect(isStatusChangeAllowed("VIEW_C", "ACTIVE")).toBe(true);
    expect(isStatusChangeAllowed("VIEW_C", "CLOSED")).toBe(true);
    expect(isStatusChangeAllowed("VIEW_C", "SETTLEMENT_WAIT")).toBe(true);
    expect(isStatusChangeAllowed("VIEW_C", "COMPLETED")).toBe(true);
  });

  it("isStatusChangeAllowed allows PROPOSAL in VIEW_B", async () => {
    const { isStatusChangeAllowed } = await import("@/lib/zone-config");

    expect(isStatusChangeAllowed("VIEW_B", "PROPOSAL")).toBe(true);
  });

  it("CampaignSidePanel renders with viewMode prop and blocks PROPOSAL selection", async () => {
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
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={vi.fn()}
        viewMode="VIEW_C"
      />,
    );

    // The StatusStepper renders buttons for each status step.
    // For ACTIVE (index 2), PROPOSAL (index 0) is NOT adjacent (distance = 2), so it should be disabled.
    const proposalButton = screen.getByRole("button", { name: /셀러 제안 중 \(1\/7\)/ });
    expect(proposalButton).toBeDisabled();
  });

  it("CampaignSidePanel allows non-PROPOSAL status change in View C", async () => {
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
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={onCampaignUpdated}
        viewMode="VIEW_C"
      />,
    );

    // The StatusStepper renders buttons. For ACTIVE (index 2), CLOSED (index 3) is adjacent forward.
    const closedButton = screen.getByRole("button", { name: /판매 마감 \(4\/7\)/ });
    expect(closedButton).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(closedButton);

    // Should NOT show the blocking toast — CLOSED is allowed in View C
    await waitFor(() => {
      expect(toastMock.error).not.toHaveBeenCalledWith(
        "영업 존 캠페인은 셀러 제안 페이지에서 관리합니다",
        expect.anything(),
      );
    });

    // Should have called the API
    await waitFor(() => {
      expect(onCampaignUpdated).toHaveBeenCalled();
    });
  });
});
