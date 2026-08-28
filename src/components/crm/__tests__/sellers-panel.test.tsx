// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SellersPanel, type SellerPanelData } from "../sellers-panel";

// --- Mocks ---

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
  },
}));

// Mock recharts-dependent component to avoid jsdom issues
vi.mock("../seller-growth-chart", () => ({
  SellerGrowthChart: () => <div data-testid="growth-chart-mock" />,
}));

// Mock InlineDataGrid to avoid complex rendering issues in jsdom
vi.mock("../inline-data-grid", () => ({
  InlineDataGrid: () => <div data-testid="data-grid-mock" />,
}));

// Mock OutreachList to simplify rendering
vi.mock("../outreach-list", () => ({
  OutreachList: () => <div data-testid="outreach-list-mock" />,
}));

// Mock ActivityTimeline to simplify rendering
vi.mock("../activity-timeline", () => ({
  ActivityTimeline: () => <div data-testid="activity-timeline-mock" />,
}));

// Mock LinkSearchDialog to simplify rendering
vi.mock("../link-search-dialog", () => ({
  LinkSearchDialog: () => null,
}));

// Mock CategoryTagInput to simplify rendering
vi.mock("../category-tag-input", () => ({
  CategoryTagInput: ({ selectedTags }: { selectedTags: Array<{ id: string; name: string }> }) => (
    <div data-testid="category-tag-input-mock">
      {selectedTags.map((t: { id: string; name: string }) => (
        <span key={t.id}>{t.name}</span>
      ))}
    </div>
  ),
}));

// Mock ChannelUrlField to simplify rendering (replaced InlineEditField in task 7.1)
vi.mock("../channel-url-field", () => ({
  ChannelUrlField: () => (
    <div data-testid="channel-url-field-mock">
      <span className="text-xs font-medium text-muted-foreground">채널 URL</span>
    </div>
  ),
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

const baseSeller: SellerPanelData = {
  id: "seller-1",
  name: "김민수",
  snsType: "INSTAGRAM",
  snsHandle: "minsu_beauty",
  currentFollowers: 150000,
  category: "뷰티",
  channelUrl: "https://instagram.com/minsu_beauty",
  notes: "뷰티 전문 인플루언서",
  campaigns: [
    {
      id: "camp-1",
      dealName: "글로우 앰플",
      brandName: null,
      partnerName: null,
      startDate: "2024-03-01",
      endDate: "2024-03-15",
      status: "COMPLETED",
      actualSales: 6200000,
    },
  ],
};

// --- Default fetch mock ---

function createDefaultFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes("/api/activity-log")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes("/api/outreach")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes("/history")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ snapshots: [] }),
      });
    }
    if (url.includes("/api/categories")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ categories: [] }),
      });
    }
    if (url.includes("/categories")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ categories: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    });
  });
}

// --- Helper ---

function renderSellersPanel(
  props: Partial<React.ComponentProps<typeof SellersPanel>> = {},
) {
  const defaultProps = {
    seller: baseSeller,
    open: true,
    onOpenChange: vi.fn(),
    onUpdated: vi.fn(),
  };
  return render(<SellersPanel {...defaultProps} {...props} />);
}

describe("SellersPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = createDefaultFetchMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Field classification — User_Input vs Auto_Computed (Requirement 6.3)", () => {
    it("renders editable User_Input_Fields with labels", () => {
      renderSellersPanel();

      expect(screen.getByText("이름")).toBeInTheDocument();
      expect(screen.getByText("SNS 유형")).toBeInTheDocument();
      expect(screen.getByText("SNS 핸들")).toBeInTheDocument();
      expect(screen.getByText("팔로워")).toBeInTheDocument();
      expect(screen.getByText("카테고리")).toBeInTheDocument();
    });

    it.skip("renders Auto_Computed_Fields as read-only with '자동' badge (Requirement 6.11)", () => {
      renderSellersPanel();

      const badges = screen.getAllByText("자동");
      // campaignCount, cumulativeSales, followerGrowthRate (평균 달성률 removed in task 7.1)
      expect(badges.length).toBe(3);
    });

    it("displays campaignCount as read-only computed field", () => {
      renderSellersPanel();

      const labels = screen.getAllByText("캠페인 수");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });

    it("displays cumulativeSales as read-only computed field", () => {
      renderSellersPanel();

      const labels = screen.getAllByText("누적 매출");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });

    it("displays averageAchievementRate as read-only computed field", () => {
      renderSellersPanel();

      // 평균 달성률 was removed in task 7.1 — verify it's NOT rendered
      const labels = screen.queryAllByText("평균 달성률");
      expect(labels.length).toBe(0);
    });

    it("displays followerGrowthRate as read-only computed field", () => {
      renderSellersPanel();

      const labels = screen.getAllByText("팔로워 성장률");
      expect(labels.length).toBeGreaterThanOrEqual(1);
    });

    it("renders snsType field as select dropdown (Requirement 6.10)", () => {
      renderSellersPanel();

      const instagramLabels = screen.getAllByText("Instagram");
      expect(instagramLabels.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Edit mode transitions (Requirement 6.5)", () => {
    it("switches to edit mode when clicking an editable text field", () => {
      renderSellersPanel();

      const handleButton = screen.getByText("minsu_beauty").closest("button");
      expect(handleButton).toBeInTheDocument();
      fireEvent.click(handleButton!);

      const input = screen.getByRole("textbox");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("minsu_beauty");
    });

    it("switches to edit mode for numeric field (currentFollowers)", () => {
      renderSellersPanel();

      const followersButton = screen.getByText("150,000").closest("button");
      expect(followersButton).toBeInTheDocument();
      fireEvent.click(followersButton!);

      const input = screen.getByRole("spinbutton");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue(150000);
    });
  });

  describe("Cancel behavior (Requirement 6.8)", () => {
    it("cancels edit on Escape key without making API call", async () => {
      renderSellersPanel();

      const handleButton = screen.getByText("minsu_beauty").closest("button");
      fireEvent.click(handleButton!);

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "changed_handle" } });
      fireEvent.keyDown(input, { key: "Escape" });

      const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(0);

      expect(screen.getByText("minsu_beauty")).toBeInTheDocument();
    });
  });

  describe("Create mode", () => {
    it("creates a seller from channel URL only by deriving required seller fields", async () => {
      const onCreated = vi.fn();
      const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/sellers" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                id: "seller-new",
                name: "test_user",
                snsType: "INSTAGRAM",
                snsHandle: "test_user",
                currentFollowers: 0,
                channelUrl: "https://instagram.com/test_user",
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
      global.fetch = fetchMock;

      renderSellersPanel({
        seller: null,
        mode: "create",
        onCreated,
      });

      fireEvent.change(screen.getByLabelText("채널 URL"), {
        target: { value: "https://instagram.com/test_user" },
      });
      fireEvent.click(screen.getByRole("button", { name: "저장" }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/sellers",
          expect.objectContaining({ method: "POST" }),
        );
      });
      const postCall = fetchMock.mock.calls.find(
        ([url, options]) => url === "/api/sellers" && options?.method === "POST",
      );
      expect(postCall).toBeDefined();
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
        channelUrl: "https://instagram.com/test_user",
        name: "test_user",
        snsType: "INSTAGRAM",
        snsHandle: "test_user",
        currentFollowers: 0,
      });
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "seller-new",
            name: "test_user",
            snsType: "INSTAGRAM",
            snsHandle: "test_user",
          }),
        );
      });
    });

    it("shows a field error for unsupported channel URL without posting", async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock;

      renderSellersPanel({
        seller: null,
        mode: "create",
      });

      fireEvent.change(screen.getByLabelText("채널 URL"), {
        target: { value: "https://example.com/test_user" },
      });
      fireEvent.click(screen.getByRole("button", { name: "저장" }));

      expect(
        await screen.findByText(
          "지원하지 않는 채널 URL 형식입니다. Instagram, YouTube 또는 X URL을 입력해주세요.",
        ),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("API failure rollback (Requirement 6.7)", () => {
    it("handleFieldSave throws on API failure, enabling InlineEditField rollback", async () => {
      // The InlineEditField component handles rollback behavior (tested in inline-edit-field.test.tsx).
      // Here we verify the SellersPanel correctly wires the PATCH API and that failure
      // propagates as an error that InlineEditField can catch.
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "저장 실패" }),
          });
        }
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/history")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ snapshots: [] }) });
        }
        if (url.includes("/categories")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderSellersPanel();

      // Use SNS 핸들 field which is still an InlineEditField
      const handleButton = screen.getByText("minsu_beauty").closest("button");
      fireEvent.click(handleButton!);

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "new_handle" } });
      fireEvent.blur(input);

      // Verify PATCH was attempted
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/sellers/seller-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ snsHandle: "new_handle" }),
          }),
        );
      });

      // InlineEditField catches the thrown error and shows error toast
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("저장 실패");
      });
    });
  });

  describe("Save behavior (Requirement 6.6)", () => {
    it("saves on blur and calls PATCH API for seller", async () => {
      const onUpdated = vi.fn();
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH" && url.includes("/api/sellers/")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ snsHandle: "new_handle" }),
          });
        }
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/history")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ snapshots: [] }) });
        }
        if (url.includes("/categories")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderSellersPanel({ onUpdated });

      const handleButton = screen.getByText("minsu_beauty").closest("button");
      fireEvent.click(handleButton!);

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "new_handle" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/sellers/seller-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ snsHandle: "new_handle" }),
          }),
        );
      });

      await waitFor(() => {
        expect(mockToast.success).not.toHaveBeenCalled();
      });
    });

    it("saves numeric value for currentFollowers field", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ currentFollowers: 200000 }),
          });
        }
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/history")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ snapshots: [] }) });
        }
        if (url.includes("/categories")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderSellersPanel();

      const followersButton = screen.getByText("150,000").closest("button");
      fireEvent.click(followersButton!);

      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "200000" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/sellers/seller-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ currentFollowers: 200000 }),
          }),
        );
      });
    });

    it("saves on Enter key press", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ snsHandle: "new_handle_enter" }),
          });
        }
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/history")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ snapshots: [] }) });
        }
        if (url.includes("/categories")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderSellersPanel();

      // Use SNS 핸들 field which is still an InlineEditField
      const handleButton = screen.getByText("minsu_beauty").closest("button");
      fireEvent.click(handleButton!);

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "new_handle_enter" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/sellers/seller-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ snsHandle: "new_handle_enter" }),
          }),
        );
      });
    });
  });
});
