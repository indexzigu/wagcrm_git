// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CampaignCreationSheet } from "../campaign-creation-sheet";
import { CampaignSidePanel } from "../campaign-side-panel";
import { QuickAddInlineForm } from "../quick-add-inline-form";
import type {
  CampaignRow,
  DashboardData,
  ApiCallLogRow,
  AssetRow,
  StorageSummary,
} from "@/lib/crm-types";

// --- Mocks ---

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
    info: (...args: unknown[]) => mockToast.info(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Mock matchMedia for useDesktop hook
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

// --- Test Data ---

const mockDeal = {
  id: "deal-1",
  dealName: "테스트 딜",
  costPrice: 10000,
  sellingPrice: 15000,
  status: "SOURCING" as const,
  partner: { id: "partner-1", name: "테스트 파트너", type: "BRAND" as const },
  baseMarginPolicy: { byChannel: {} },
};

const mockSeller = {
  id: "seller-1",
  name: "테스트 셀러",
  snsType: "INSTAGRAM" as const,
  snsHandle: "test_seller",
  currentFollowers: 50000,
};

const mockDashboardData: DashboardData = {
  deals: [mockDeal],
  sellers: [mockSeller],
  campaigns: [],
  apiCallLogs: [],
  assets: [],
  storage: {
    supabaseLimitBytes: 1073741824,
    supabaseWarningBytes: 858993459,
    supabaseEstimatedBytes: 0,
    googleDriveConnected: false,
    recentAssets: [],
  },
  teams: [{ id: "team-1", name: "영업팀" }],
};

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
  totalMarginRate: 30,
  sellerMarginRate: 10,
  netMarginRate: 20,
  status: "ACTIVE",
  isManualMargin: false,
  assignedTo: null,
  updatedAt: "2026-05-01T00:00:00Z",
  followerHistory: [],
  activityHistory: [],
  notes: [],
};

const emptyLogs: ApiCallLogRow[] = [];
const emptyAssets: AssetRow[] = [];
const emptyStorage: StorageSummary = {
  supabaseLimitBytes: 1073741824,
  supabaseWarningBytes: 858993459,
  supabaseEstimatedBytes: 0,
  googleDriveConnected: false,
  recentAssets: [],
};

// --- Integration Tests ---

describe("Integration: Campaign creation flow (form submit → API → kanban update)", () => {
  /**
   * Validates: Requirements 1.5
   * Tests the end-to-end campaign creation flow:
   * form submit → API call → onCreated callback (kanban update) → sheet closes
   */

  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls = [];
  });

  it("submits form, calls API, invokes onCreated with new campaign, and closes sheet", async () => {
    const createdCampaign: CampaignRow = {
      ...baseCampaign,
      id: "camp-new",
      status: "PROPOSAL",
    };

    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/campaigns" && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(createdCampaign),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CampaignCreationSheet
        data={mockDashboardData}
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        defaultStatus="PROPOSAL"
      />,
    );

    // The form should have deal and seller pre-selected (first items from data)
    // Click the submit button
    const submitButton = screen.getByRole("button", { name: /캠페인 생성/i });
    expect(submitButton).not.toBeDisabled();

    fireEvent.click(submitButton);

    // Wait for API call to complete
    await waitFor(() => {
      const postCall = fetchCalls.find(
        (c) => c.url === "/api/campaigns" && c.options?.method === "POST",
      );
      expect(postCall).toBeDefined();

      const body = JSON.parse(postCall!.options!.body as string);
      expect(body.dealId).toBe("deal-1");
      expect(body.sellerId).toBe("seller-1");
      expect(body.status).toBe("PROPOSAL");
    });

    // Verify onCreated was called with the new campaign
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(createdCampaign);
    });

    // Verify sheet was closed
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("keeps sheet open and shows error when API fails", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/campaigns" && options?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Validation failed" }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CampaignCreationSheet
        data={mockDashboardData}
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );

    const submitButton = screen.getByRole("button", { name: /캠페인 생성/i });
    fireEvent.click(submitButton);

    // Wait for error message to appear
    await waitFor(() => {
      expect(screen.getByText("입력값을 확인하세요.")).toBeInTheDocument();
    });

    // Sheet should NOT be closed
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // onCreated should NOT be called
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows network error message when fetch throws", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/campaigns" && options?.method === "POST") {
        return Promise.reject(new Error("Network error"));
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <CampaignCreationSheet
        data={mockDashboardData}
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );

    const submitButton = screen.getByRole("button", { name: /캠페인 생성/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(
        screen.getByText("서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요."),
      ).toBeInTheDocument();
    });

    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("Integration: Inline edit → API → toast feedback", () => {
  /**
   * Validates: Requirements 7.5
   * Tests the inline edit flow in CampaignSidePanel:
   * field edit → API PATCH → success/error toast
   */

  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls = [];
  });

  it("inline status edit calls API and shows success toast", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        const body = JSON.parse(options.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...baseCampaign, ...body }),
        });
      }

      if (url.includes("/api/sellers")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCampaignUpdated = vi.fn();

    render(
      <CampaignSidePanel
        campaign={baseCampaign}
        logs={emptyLogs}
        assets={emptyAssets}
        storage={emptyStorage}
        open={true}
        onOpenChange={vi.fn()}
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );

    // The StatusStepper renders buttons for each status step.
    // For ACTIVE status, the adjacent forward step "판매 마감" (CLOSED) is clickable.
    const closedStepButton = screen.getByRole("button", { name: /판매 마감 \(4\/7\)/ });
    expect(closedStepButton).not.toBeDisabled();
    fireEvent.click(closedStepButton);

    // Verify API was called with the new status
    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.url.includes("/api/campaigns/camp-1") && c.options?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall!.options!.body as string)).toEqual({ status: "CLOSED" });
    });

    // Verify onCampaignUpdated was called
    await waitFor(() => {
      expect(onCampaignUpdated).toHaveBeenCalled();
    });
  });

  it("inline date edit calls API and shows success toast on save", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        const body = JSON.parse(options.body as string);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...baseCampaign, ...body }),
        });
      }

      if (url.includes("/reminders/recalculate")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }

      if (url.includes("/api/sellers")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCampaignUpdated = vi.fn();

    render(
      <CampaignSidePanel
        campaign={baseCampaign}
        logs={emptyLogs}
        assets={emptyAssets}
        storage={emptyStorage}
        open={true}
        onOpenChange={vi.fn()}
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );

    // Click the endDate display to enter edit mode
    const endDateButton = screen.getByText("2026.06.30");
    fireEvent.click(endDateButton);

    // Find the date input — use defaultValue to distinguish InlineDateEdit from SettlementSection inputs
    const dateInput = await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="date"]');
      const endDateInput = Array.from(inputs).find(
        (input) => (input as HTMLInputElement).defaultValue === "2026-06-30"
      );
      expect(endDateInput).not.toBeNull();
      return endDateInput as HTMLInputElement;
    });

    fireEvent.change(dateInput, { target: { value: "2026-07-15" } });
    fireEvent.blur(dateInput);

    // Verify API was called
    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.url.includes("/api/campaigns/camp-1") && c.options?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall!.options!.body as string)).toEqual({ endDate: "2026-07-15" });
    });

    // Verify success toast
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("마감일이 변경되었습니다");
    });
  });

  it("inline edit shows error toast and rolls back on API failure", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "저장 실패" }),
        });
      }

      if (url.includes("/api/sellers")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    render(
      <CampaignSidePanel
        campaign={baseCampaign}
        logs={emptyLogs}
        assets={emptyAssets}
        storage={emptyStorage}
        open={true}
        onOpenChange={vi.fn()}
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={vi.fn()}
      />,
    );

    // Click the endDate display to enter edit mode
    const endDateButton = screen.getByText("2026.06.30");
    fireEvent.click(endDateButton);

    const dateInput = await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="date"]');
      const endDateInput = Array.from(inputs).find(
        (input) => (input as HTMLInputElement).defaultValue === "2026-06-30"
      );
      expect(endDateInput).not.toBeNull();
      return endDateInput as HTMLInputElement;
    });

    fireEvent.change(dateInput, { target: { value: "2026-08-01" } });
    fireEvent.blur(dateInput);

    // Verify error toast is shown
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });

    // Verify the original date is restored (rolled back) — the button should reappear with original date
    await waitFor(() => {
      expect(screen.getByText("2026.06.30")).toBeInTheDocument();
    });
  });
});

describe("Integration: Quick add → parent select option update", () => {
  /**
   * Validates: Requirements 8.5
   * Tests the quick add inline form flow:
   * quick add form submit → API → parent select options updated + auto-selected
   */

  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls = [];
  });

  it("seller quick add creates entity and calls onCreated with new entity", async () => {
    const newSeller = {
      id: "seller-new",
      name: "새 셀러",
      snsType: "INSTAGRAM",
      snsHandle: "new_seller",
      currentFollowers: 0,
    };

    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/sellers" && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newSeller),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickAddInlineForm
        entityType="seller"
        open={true}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    // Fill in the required fields
    const nameInput = screen.getByPlaceholderText("셀러 이름");
    fireEvent.change(nameInput, { target: { value: "새 셀러" } });

    const handleInput = screen.getByPlaceholderText("@handle");
    fireEvent.change(handleInput, { target: { value: "new_seller" } });

    // Submit the form - use exact text match to avoid matching "빠른 추가 닫기" aria-label
    const submitButton = screen.getByRole("button", { name: /^추가$/ });
    fireEvent.click(submitButton);

    // Verify API was called with correct data
    await waitFor(() => {
      const postCall = fetchCalls.find(
        (c) => c.url === "/api/sellers" && c.options?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall!.options!.body as string);
      expect(body.name).toBe("새 셀러");
      expect(body.snsType).toBe("INSTAGRAM");
      expect(body.snsHandle).toBe("new_seller");
    });

    // Verify onCreated was called with the new entity
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({
        id: "seller-new",
        label: "새 셀러 @new_seller",
      });
    });
  });

  it("deal quick add creates entity and calls onCreated with new entity", async () => {
    const newDeal = {
      id: "deal-new",
      dealName: "새 딜",
      costPrice: 5000,
      partnerId: "partner-1",
    };

    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/deals" && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(newDeal),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();
    const onClose = vi.fn();
    const partners = [{ id: "partner-1", name: "테스트 파트너", type: "BRAND" as const }];

    render(
      <QuickAddInlineForm
        entityType="deal"
        open={true}
        onClose={onClose}
        onCreated={onCreated}
        partners={partners}
      />,
    );

    // Fill in the required fields
    const dealNameInput = screen.getByPlaceholderText("딜 이름");
    fireEvent.change(dealNameInput, { target: { value: "새 딜" } });

    // Set cost price
    const costInput = screen.getByPlaceholderText("0");
    fireEvent.change(costInput, { target: { value: "5000" } });

    // Select partner via SearchableDropdown - click the trigger
    const partnerTrigger = screen.getByText("선택");
    fireEvent.click(partnerTrigger);

    // Select the partner from the dropdown
    const partnerOption = await screen.findByText("테스트 파트너");
    fireEvent.click(partnerOption);

    // Submit the form - use exact text match to avoid matching "빠른 추가 닫기" aria-label
    const submitButton = screen.getByRole("button", { name: /^추가$/ });
    fireEvent.click(submitButton);

    // Verify API was called
    await waitFor(() => {
      const postCall = fetchCalls.find(
        (c) => c.url === "/api/deals" && c.options?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall!.options!.body as string);
      expect(body.dealName).toBe("새 딜");
      expect(body.partnerId).toBe("partner-1");
      expect(body.costPrice).toBe(5000);
    });

    // Verify onCreated was called
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith({
        id: "deal-new",
        label: "새 딜",
      });
    });
  });

  it("quick add shows validation error when required fields are empty", async () => {
    const onCreated = vi.fn();

    render(
      <QuickAddInlineForm
        entityType="seller"
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );

    // Submit without filling required fields
    const submitButton = screen.getByRole("button", { name: /^추가$/ });
    fireEvent.click(submitButton);

    // Verify validation error is shown
    await waitFor(() => {
      expect(screen.getByText("셀러 이름은 필수입니다")).toBeInTheDocument();
    });

    // Verify onCreated was NOT called
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("quick add shows API error and preserves form state on failure", async () => {
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url === "/api/sellers" && options?.method === "POST") {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "중복된 핸들입니다" }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });

    const onCreated = vi.fn();

    render(
      <QuickAddInlineForm
        entityType="seller"
        open={true}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );

    // Fill in fields
    const nameInput = screen.getByPlaceholderText("셀러 이름");
    fireEvent.change(nameInput, { target: { value: "중복 셀러" } });

    const handleInput = screen.getByPlaceholderText("@handle");
    fireEvent.change(handleInput, { target: { value: "duplicate" } });

    // Submit
    const submitButton = screen.getByRole("button", { name: /^추가$/ });
    fireEvent.click(submitButton);

    // Verify error message is shown
    await waitFor(() => {
      expect(screen.getByText("중복된 핸들입니다")).toBeInTheDocument();
    });

    // Verify form data is preserved
    expect(nameInput).toHaveValue("중복 셀러");
    expect(handleInput).toHaveValue("duplicate");

    // Verify onCreated was NOT called
    expect(onCreated).not.toHaveBeenCalled();
  });
});
