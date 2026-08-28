// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import type { CampaignRow, AssetRow, ApiCallLogRow, StorageSummary } from "@/lib/crm-types";

// --- Mocks ---

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
  },
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

// --- Helper ---

function renderPanel(props: Partial<React.ComponentProps<typeof CampaignSidePanel>> = {}) {
  const defaultProps = {
    campaign: baseCampaign,
    logs: emptyLogs,
    assets: emptyAssets,
    storage: emptyStorage,
    open: true,
    onOpenChange: vi.fn(),
    onActualSalesSaved: vi.fn(),
    onCampaignUpdated: vi.fn(),
  };
  return render(<CampaignSidePanel {...defaultProps} {...props} />);
}

describe("CampaignSidePanel — endDate change → reminder recalculation (Requirements 1.1, 1.2)", () => {
  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchCalls = [];

    // Track all fetch calls and provide appropriate responses
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      // PATCH campaign endpoint — endDate update
      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        const body = JSON.parse(options.body as string);
        const updatedCampaign = { ...baseCampaign, ...body };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(updatedCampaign),
        });
      }

      // POST reminders/recalculate endpoint
      if (url.includes("/api/campaigns/camp-1/reminders/recalculate") && options?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }

      // GET sellers (fetched on panel open)
      if (url.includes("/api/sellers")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      // GET checklist
      if (url.includes("/api/campaigns/camp-1/checklist")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [] }),
        });
      }

      // Default response
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });
  });

  it("calls PATCH endDate then POST reminders/recalculate in sequence when endDate is changed", async () => {
    const onCampaignUpdated = vi.fn();
    renderPanel({ onCampaignUpdated });

    // Find the endDate display and click to enter edit mode
    // The endDate is displayed as "2026.06.30" (formatted from "2026-06-30")
    const endDateButton = screen.getByText("2026.06.30");
    fireEvent.click(endDateButton);

    // Now a date input should appear in the InlineDateEdit — find it within the 일정 section
    // The SettlementSection also has date inputs, so we need to be specific
    const dateInput = await waitFor(() => {
      // The InlineDateEdit renders a date input with defaultValue (not value) when in edit mode
      const inputs = document.querySelectorAll('input[type="date"]');
      // Find the one that has the endDate value as defaultValue (InlineDateEdit uses defaultValue)
      const endDateInput = Array.from(inputs).find(
        (input) => (input as HTMLInputElement).defaultValue === "2026-06-30"
      );
      expect(endDateInput).not.toBeNull();
      return endDateInput as HTMLInputElement;
    });

    // Change the endDate value and blur to trigger save
    fireEvent.change(dateInput, { target: { value: "2026-07-15" } });
    fireEvent.blur(dateInput);

    // Wait for the API calls to complete
    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.url.includes("/api/campaigns/camp-1") && c.options?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
      expect(JSON.parse(patchCall!.options!.body as string)).toEqual({ endDate: "2026-07-15" });
    });

    // Verify reminder recalculation is called AFTER the PATCH
    await waitFor(() => {
      const recalcCall = fetchCalls.find(
        (c) => c.url.includes("/api/campaigns/camp-1/reminders/recalculate") && c.options?.method === "POST"
      );
      expect(recalcCall).toBeDefined();
    });

    // Verify the sequence: PATCH comes before POST recalculate
    const patchIndex = fetchCalls.findIndex(
      (c) => c.url.includes("/api/campaigns/camp-1") && c.options?.method === "PATCH"
    );
    const recalcIndex = fetchCalls.findIndex(
      (c) => c.url.includes("/api/campaigns/camp-1/reminders/recalculate")
    );
    expect(patchIndex).toBeLessThan(recalcIndex);
  });

  it("does NOT call reminders/recalculate when startDate is changed", async () => {
    renderPanel();

    // Find the startDate display and click to enter edit mode
    const startDateButton = screen.getByText("2026.01.01");
    fireEvent.click(startDateButton);

    const dateInput = await waitFor(() => {
      const inputs = document.querySelectorAll('input[type="date"]');
      const startDateInput = Array.from(inputs).find(
        (input) => (input as HTMLInputElement).defaultValue === "2026-01-01"
      );
      expect(startDateInput).not.toBeNull();
      return startDateInput as HTMLInputElement;
    });

    fireEvent.change(dateInput, { target: { value: "2026-01-15" } });
    fireEvent.blur(dateInput);

    // Wait for the PATCH to complete
    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.url.includes("/api/campaigns/camp-1") && c.options?.method === "PATCH"
      );
      expect(patchCall).toBeDefined();
    });

    // Give time for any async calls to settle
    await new Promise((r) => setTimeout(r, 100));

    // Verify reminders/recalculate was NOT called
    const recalcCall = fetchCalls.find(
      (c) => c.url.includes("/reminders/recalculate")
    );
    expect(recalcCall).toBeUndefined();
  });

  it("still shows success toast for endDate even if reminder recalculation fails", async () => {
    // Override fetch to make recalculate fail
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...baseCampaign, endDate: "2026-07-15" }),
        });
      }

      if (url.includes("/reminders/recalculate")) {
        return Promise.reject(new Error("Network error"));
      }

      if (url.includes("/api/sellers")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }

      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    renderPanel();

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

    fireEvent.change(dateInput, { target: { value: "2026-07-15" } });
    fireEvent.blur(dateInput);

    // endDate save success toast should still appear (Requirement 1.4)
    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith("마감일이 변경되었습니다");
    });

    // Error toast should NOT appear for reminder failure (non-blocking)
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it("does NOT call reminders/recalculate when endDate PATCH fails", async () => {
    // Override fetch to make PATCH fail
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      fetchCalls.push({ url, options });

      if (url.includes("/api/campaigns/camp-1") && options?.method === "PATCH") {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "저장 실패" }),
        });
      }

      if (url.includes("/api/sellers")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }

      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    renderPanel();

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

    fireEvent.change(dateInput, { target: { value: "2026-07-15" } });
    fireEvent.blur(dateInput);

    // Wait for error toast
    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });

    // Give time for any async calls to settle
    await new Promise((r) => setTimeout(r, 100));

    // Verify reminders/recalculate was NOT called since PATCH failed
    const recalcCall = fetchCalls.find(
      (c) => c.url.includes("/reminders/recalculate")
    );
    expect(recalcCall).toBeUndefined();
  });
});
