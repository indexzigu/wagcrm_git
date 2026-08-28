import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DealsPanel, type DealPanelData } from "../deals-panel";

// --- Mocks ---

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
    info: (...args: unknown[]) => mockToast.info(...args),
  },
}));

// Mock matchMedia for useDesktop hook
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: true, // desktop mode
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

const baseDeal: DealPanelData = {
  id: "deal-1",
  dealName: "테스트 딜",
  brandName: "테스트 브랜드",
  partnerName: "테스트 파트너",
  partnerId: "partner-1",
  costPrice: 10000,
  supplyPrice: 10000,
  sellingPrice: 15000,
  listPrice: 20000,
  floorPrice: 12000,
  discountRate: 25,
  totalCommissionRate: 10,
  brokerageCommissionRate: 5,
  sourcingMemo: null,
  candidateSellers: null,
  status: "SOURCING",
  baseMarginPolicy: { byChannel: {} },
  createdAt: "2024-01-01T00:00:00Z",
};

// --- Helper ---

function renderDealsPanel(props: Partial<React.ComponentProps<typeof DealsPanel>> = {}) {
  const defaultProps = {
    deal: baseDeal,
    open: true,
    onOpenChange: vi.fn(),
    onUpdated: vi.fn(),
    onDeleted: vi.fn(),
  };
  return render(<DealsPanel {...defaultProps} {...props} />);
}

function getInlineEditInput(label: string) {
  const button = screen.getByRole("button", { name: `${label} 수정` });
  fireEvent.click(button);
  const labelSpan = screen.getByText(label);
  const row = labelSpan.closest("div.group\\/field, div.group");
  const input = row?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Edit input not found for label: ${label}`);
  }
  return input;
}

function getOptionFormInput(label: string) {
  const textNode = screen.getByText(label);
  const fieldWrapper = textNode.parentElement;
  const input = fieldWrapper?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label: ${label}`);
  }
  return input;
}

describe("DealsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default fetch mock: return empty arrays for activity log, comments, and campaigns
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/activity-log")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entries: [] }),
        });
      }
      if (url.includes("/api/comments")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }
      if (url.includes("/api/campaigns")) {
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
  });

  describe("Field classification — User_Input vs Auto_Computed (Requirement 2.1)", () => {
    it("renders User_Input_Fields as editable InlineEditFields", () => {
      renderDealsPanel();

      // User_Input_Fields should be present with their labels
      expect(screen.getAllByText("정상가").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("판매가")).toBeInTheDocument();
      expect(screen.getByText("공급가")).toBeInTheDocument();
      expect(screen.getByText("브랜드")).toBeInTheDocument();
      expect(screen.getByText("최저가")).toBeInTheDocument();
      expect(screen.getByText("수수료 정책")).toBeInTheDocument();
    });

    it.skip("renders discountRate as Auto_Computed_Field with '자동' badge (Requirement 2.8)", () => {
      renderDealsPanel();

      expect(screen.getByText("할인율")).toBeInTheDocument();
      const autoBadges = screen.getAllByText("자동");
      expect(autoBadges.length).toBeGreaterThanOrEqual(1);
    });

    it("displays computed discountRate value based on listPrice and sellingPrice", () => {
      // discountRate = (20000 - 15000) / 20000 * 100 = 25
      renderDealsPanel();

      expect(screen.getByText("25%")).toBeInTheDocument();
    });

    it("displays '-' for discountRate when listPrice is null (Requirement 2.7)", () => {
      renderDealsPanel({
        deal: { ...baseDeal, listPrice: null },
      });

      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
    });

    it("displays formatted currency values for numeric User_Input_Fields", () => {
      renderDealsPanel();

      // supplyPrice: 15,000원 × (1 - 10%) = 13,500원
      expect(screen.getByText("13,500원")).toBeInTheDocument();
      // sellingPrice: 15,000원
      expect(screen.getByText("15,000원")).toBeInTheDocument();
      // listPrice: 20,000원
      expect(screen.getByText("20,000원")).toBeInTheDocument();
      // floorPrice: 12,000원
      expect(screen.getByText("12,000원")).toBeInTheDocument();
    });

    it("displays percentage values for commission rate fields", () => {
      renderDealsPanel();

      expect(screen.getByText("수수료 정책")).toBeInTheDocument();
      expect(screen.getByText("자사몰(기타) 수수료율 (%)")).toBeInTheDocument();
    });

    it("places the margin policy section above the linked partner section", () => {
      renderDealsPanel();

      const marginHeading = screen.getByText("수수료 정책");
      const partnerHeading = screen.getByText("연결된 거래처");

      expect(
        marginHeading.compareDocumentPosition(partnerHeading) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("uses the service-standard numeric input style in the margin policy section", () => {
      renderDealsPanel();

      const label = screen.getByText("자사몰(기타) 수수료율 (%)");
      const ownMallInput = label.parentElement?.querySelector("input");
      
      expect(ownMallInput).toBeInTheDocument();
      expect(ownMallInput).toHaveClass("h-7");
      expect(ownMallInput).toHaveClass("p-0");
      expect(ownMallInput).toHaveClass("tabular-nums");
      expect(ownMallInput).toHaveClass("text-sm");
    });

    it("places group selling price before readonly cost price in the option form and auto-fills cost price", () => {
      renderDealsPanel();

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));

      const sellingLabel = screen.getByText("공구 판매가 (원)");
      const costLabel = screen.getByText("공급가 (원)");

      expect(
        sellingLabel.compareDocumentPosition(costLabel) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();

      fireEvent.change(getOptionFormInput("수수료율 (%)"), { target: { value: "10" } });
      fireEvent.change(getOptionFormInput("공구 판매가 (원)"), { target: { value: "42000" } });

      expect(screen.getByText("37,800원")).toBeInTheDocument();
    });

    it("keeps only the section-level sales task CTA in deal detail", () => {
      renderDealsPanel({
        deal: { ...baseDeal, status: "CONFIRMED" },
      });

      const linkButtons = screen.getAllByRole("button", { name: "연결" });
      expect(linkButtons.length).toBeGreaterThan(0);
      expect(screen.queryByRole("button", { name: "영업 테스크 만들기" })).not.toBeInTheDocument();
    });
  });

  describe("Deal status progression", () => {
    it("renders status steps in the actual pipeline order", () => {
      renderDealsPanel({ deal: { ...baseDeal, status: "NEGOTIATING" } });

      const stepButtons = ["발굴", "협의", "샘플 테스트", "확정"].map((name) =>
        screen.getByRole("button", { name })
      );

      stepButtons.forEach((button, index) => {
        const nextButton = stepButtons[index + 1];
        if (!nextButton) return;
        expect(
          button.compareDocumentPosition(nextButton) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
      });
    });

    it("allows moving from sample testing to confirmed while keeping earlier steps disabled", () => {
      renderDealsPanel({ deal: { ...baseDeal, status: "SAMPLE_TESTING" } });

      expect(screen.getByRole("button", { name: "샘플 테스트" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "발굴" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "협의" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "확정" })).not.toBeDisabled();
    });
  });

  describe("Deal deletion flow (Requirements 2.9, 2.10)", () => {
    it("renders '딜 삭제' button", () => {
      renderDealsPanel();

      expect(screen.getByRole("button", { name: /딜 삭제/ })).toBeInTheDocument();
    });

    it("shows confirm dialog when delete button is clicked", async () => {
      renderDealsPanel();

      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      await waitFor(() => {
        expect(screen.getByText("딜을 삭제하시겠습니까?")).toBeInTheDocument();
        expect(
          screen.getByText(/이 작업은 되돌릴 수 없습니다/)
        ).toBeInTheDocument();
      });
    });

    it("sends DELETE request and closes panel on confirmation (Requirement 2.9)", async () => {
      const onDeleted = vi.fn();
      const onOpenChange = vi.fn();

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderDealsPanel({ onDeleted, onOpenChange });

      // Open confirm dialog
      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      // Click confirm button in dialog
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "삭제" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/deal-1",
          expect.objectContaining({ method: "DELETE" })
        );
      });

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith("딜이 삭제되었습니다");
        expect(onDeleted).toHaveBeenCalledWith("deal-1");
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it("shows error toast and keeps panel open on DELETE failure (Requirement 2.10)", async () => {
      const onDeleted = vi.fn();
      const onOpenChange = vi.fn();

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "삭제 권한이 없습니다" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderDealsPanel({ onDeleted, onOpenChange });

      // Open confirm dialog
      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      // Click confirm
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "삭제" }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("삭제 권한이 없습니다");
      });

      // Panel should NOT close
      expect(onDeleted).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it("shows generic error toast when DELETE fails with no error message", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") {
          return Promise.resolve({
            ok: false,
            json: () => Promise.reject(new Error("parse error")),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderDealsPanel();

      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "삭제" }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("딜 삭제에 실패했습니다");
      });
    });

    it("shows error toast when DELETE request throws network error", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") {
          return Promise.reject(new Error("Network error"));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderDealsPanel();

      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole("button", { name: "삭제" }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("딜 삭제에 실패했습니다");
      });
    });

    it("displays deal name in the confirmation dialog", async () => {
      renderDealsPanel();

      fireEvent.click(screen.getByRole("button", { name: /딜 삭제/ }));

      await waitFor(() => {
        expect(
          screen.getByText(/영구적으로 삭제됩니다/)
        ).toBeInTheDocument();
      });
    });
  });

  describe("모델명 필드 (P1-4)", () => {
    it("검색 키워드 필드와 나란히 '모델명' 편집 필드를 렌더링한다", () => {
      renderDealsPanel({
        deal: {
          ...baseDeal,
          supplementaryInfo: JSON.stringify({
            searchKeyword: "휴브론 3 in 1 무선고데기",
            modelName: "PB-10000X",
            referenceUrl: "",
            supplementaryInfo: "",
          }),
        },
      });

      expect(screen.getByText("모델명")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "모델명 수정" }));
      expect(screen.getByDisplayValue("PB-10000X")).toBeInTheDocument();
    });

    it("modelName이 없는 기존 데이터(레거시)는 빈 값으로 렌더링된다 (회귀 금지)", () => {
      renderDealsPanel({
        deal: {
          ...baseDeal,
          supplementaryInfo: JSON.stringify({
            searchKeyword: "종근당 락토핏 골드",
            referenceUrl: "",
            supplementaryInfo: "",
          }),
        },
      });

      expect(screen.getByText("모델명")).toBeInTheDocument();
      // modelName 필드가 없어도 크래시 없이 렌더링되고, 편집 모드 진입 시 빈 입력값이다.
      fireEvent.click(screen.getByRole("button", { name: "모델명 수정" }));
      const inputs = screen.getAllByDisplayValue("");
      expect(inputs.length).toBeGreaterThan(0);
    });

    it("키워드 추출 버튼 클릭 시 searchKeyword와 modelName을 함께 저장한다", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ sellers: [] }) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ outreaches: [] }) });
        }
        if (url.includes("/api/deals/extract-info")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                searchKeyword: "휴브론 3 in 1 무선고데기",
                modelName: "PB-10000X",
                crawl: { attempted: true, ok: true },
              }),
          });
        }
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                campaigns: [],
                options: [],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ campaigns: [] }) });
      });

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [],
          supplementaryInfo: JSON.stringify({
            searchKeyword: "",
            modelName: "",
            referenceUrl: "https://hubron.co.kr/product/x/21/",
            supplementaryInfo: "",
          }),
        },
      });

      fireEvent.click(screen.getByRole("button", { name: /키워드 추출/ }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/extract-info",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await waitFor(() => {
        const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
          (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patchCalls.length).toBeGreaterThan(0);
        const lastPatchOptions = patchCalls[patchCalls.length - 1][1] as RequestInit;
        const lastPatchBody = JSON.parse(lastPatchOptions.body as string);
        const supplementaryInfoParsed = JSON.parse(lastPatchBody.supplementaryInfo);
        expect(supplementaryInfoParsed.searchKeyword).toBe("휴브론 3 in 1 무선고데기");
        expect(supplementaryInfoParsed.modelName).toBe("PB-10000X");
      });
    });
  });

  describe("공식 스토어 링크 저장 시 키워드 자동 추출 (UX1-A)", () => {
    function setupFetchMock() {
      return vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ sellers: [] }) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ outreaches: [] }) });
        }
        if (url.includes("/api/deals/extract-info")) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                searchKeyword: "자동추출 키워드",
                modelName: "AUTO-MODEL",
                crawl: { attempted: true, ok: true },
              }),
          });
        }
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ...baseDeal, campaigns: [], options: [] }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ campaigns: [] }) });
      });
    }

    function getExtractInfoCallCount() {
      return (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("/api/deals/extract-info"),
      ).length;
    }

    it("searchKeyword가 비어있을 때 유효한 URL을 저장하면 키워드 추출이 자동 실행된다", async () => {
      global.fetch = setupFetchMock();

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [],
          supplementaryInfo: JSON.stringify({
            searchKeyword: "",
            modelName: "",
            referenceUrl: "",
            supplementaryInfo: "",
          }),
        },
      });

      const urlInput = getInlineEditInput("공식 스토어 링크");
      fireEvent.change(urlInput, { target: { value: "https://hubron.co.kr/product/x/21/" } });
      fireEvent.blur(urlInput);

      await waitFor(() => {
        expect(getExtractInfoCallCount()).toBeGreaterThan(0);
      });

      await waitFor(() => {
        expect(mockToast.info).toHaveBeenCalledWith(
          expect.stringContaining("키워드 자동 추출"),
        );
      });
    });

    it("searchKeyword가 이미 있으면 URL을 저장해도 자동 추출을 트리거하지 않는다", async () => {
      global.fetch = setupFetchMock();

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [],
          supplementaryInfo: JSON.stringify({
            searchKeyword: "이미 있는 키워드",
            modelName: "",
            referenceUrl: "",
            supplementaryInfo: "",
          }),
        },
      });

      const urlInput = getInlineEditInput("공식 스토어 링크");
      fireEvent.change(urlInput, { target: { value: "https://hubron.co.kr/product/x/21/" } });
      fireEvent.blur(urlInput);

      // 딜 이름 필드를 다시 열고 닫아 React 상태 갱신을 대기시킨다 (deferred save라 PATCH가 즉시 발생하지 않음).
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "공식 스토어 링크 수정" })).toBeInTheDocument();
      });

      expect(getExtractInfoCallCount()).toBe(0);
    });

    it("무효한 URL(http/https가 아님)을 저장하면 자동 추출을 트리거하지 않는다", async () => {
      global.fetch = setupFetchMock();

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [],
          supplementaryInfo: JSON.stringify({
            searchKeyword: "",
            modelName: "",
            referenceUrl: "",
            supplementaryInfo: "",
          }),
        },
      });

      const urlInput = getInlineEditInput("공식 스토어 링크");
      fireEvent.change(urlInput, { target: { value: "그냥텍스트" } });
      fireEvent.blur(urlInput);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "공식 스토어 링크 수정" })).toBeInTheDocument();
      });

      expect(getExtractInfoCallCount()).toBe(0);
    });
  });

  describe("하위 옵션 모델명 — 자식 단위 1차 저장 (UX1-B)", () => {
    it("새 옵션 등록 폼에 '모델명' 입력이 렌더링된다", () => {
      renderDealsPanel({
        deal: { ...baseDeal, campaigns: [], options: [] },
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));

      expect(screen.getByPlaceholderText("예: PB-10000X")).toBeInTheDocument();
    });

    it("모델명을 입력하고 옵션을 추가하면 supplementaryInfo가 JSON {supplementaryInfo, modelName}으로 저장된다", async () => {
      const onUpdated = vi.fn();
      let capturedPostBody: Record<string, unknown> | null = null;

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ sellers: [] }) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ outreaches: [] }) });
        }
        if (url === "/api/deals" && options?.method === "POST") {
          capturedPostBody = JSON.parse(options.body as string);
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "opt-1" }) });
        }
        if (url === "/api/deals/deal-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                baseMarginPolicy: { byChannel: {} },
                campaigns: [],
                options: [
                  {
                    id: "opt-1",
                    dealName: "3통 구성",
                    costPrice: 30000,
                    sellingPrice: 42000,
                    totalCommissionRate: 10,
                    dealType: "OPTION",
                    optionSortOrder: 0,
                    parentDealId: "deal-1",
                    supplementaryInfo: JSON.stringify({
                      supplementaryInfo: "",
                      modelName: "PB-10000X",
                    }),
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderDealsPanel({
        deal: { ...baseDeal, campaigns: [], options: [] },
        onUpdated,
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.change(screen.getByPlaceholderText("예: 1통"), {
        target: { value: "3통 구성" },
      });
      fireEvent.change(screen.getByPlaceholderText("예: PB-10000X"), {
        target: { value: "PB-10000X" },
      });
      fireEvent.change(getOptionFormInput("수수료율 (%)"), { target: { value: "10" } });
      fireEvent.change(getOptionFormInput("공구 판매가 (원)"), { target: { value: "42000" } });
      fireEvent.click(screen.getByRole("button", { name: "옵션 추가하기" }));

      await waitFor(() => {
        expect(capturedPostBody).not.toBeNull();
      });

      const body = capturedPostBody as unknown as { supplementaryInfo: string };
      const parsedSupplementary = JSON.parse(body.supplementaryInfo);
      expect(parsedSupplementary.modelName).toBe("PB-10000X");
      expect(parsedSupplementary.supplementaryInfo).toBe("");
    });

    it("모델명을 입력하지 않으면 기존처럼 자유텍스트 그대로 저장된다 (레거시 경로 불변)", async () => {
      let capturedPostBody: Record<string, unknown> | null = null;

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ sellers: [] }) });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ outreaches: [] }) });
        }
        if (url === "/api/deals" && options?.method === "POST") {
          capturedPostBody = JSON.parse(options.body as string);
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "opt-1" }) });
        }
        if (url === "/api/deals/deal-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ ...baseDeal, baseMarginPolicy: { byChannel: {} }, campaigns: [], options: [] }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });

      renderDealsPanel({
        deal: { ...baseDeal, campaigns: [], options: [] },
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.change(screen.getByPlaceholderText("예: 1통"), {
        target: { value: "3통 구성" },
      });
      fireEvent.change(getOptionFormInput("수수료율 (%)"), { target: { value: "10" } });
      fireEvent.change(getOptionFormInput("공구 판매가 (원)"), { target: { value: "42000" } });
      fireEvent.click(screen.getByRole("button", { name: "옵션 추가하기" }));

      await waitFor(() => {
        expect(capturedPostBody).not.toBeNull();
      });

      const body = capturedPostBody as unknown as { supplementaryInfo: string | null };
      expect(body.supplementaryInfo).toBeNull();
    });

    it("기존 JSON 옵션을 수정 모드로 열면 모델명/보조정보 필드가 각각 분리되어 채워진다", () => {
      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [
            {
              id: "opt-1",
              dealName: "테스트 딜 - 3통 구성",
              costPrice: 30000,
              sellingPrice: 42000,
              totalCommissionRate: 10,
              dealType: "OPTION",
              optionSortOrder: 0,
              parentDealId: "deal-1",
              supplementaryInfo: JSON.stringify({
                supplementaryInfo: "1개월분",
                modelName: "PB-10000X",
              }),
            },
          ],
        },
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.click(screen.getByRole("button", { name: "테스트 딜 - 3통 구성 수정" }));

      expect(screen.getByDisplayValue("PB-10000X")).toBeInTheDocument();
    });
  });

  describe("Inline save and option refresh", () => {
    it("calculates supplyPrice when saving totalCommissionRate", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ entries: [] }),
          });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sellers: [] }),
          });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ outreaches: [] }),
          });
        }
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                partnerName: baseDeal.partnerName,
                supplyPrice: 12000,
                totalCommissionRate: 20,
                baseMarginPolicy: { byChannel: {} },
                campaigns: [],
                options: [],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ campaigns: [] }),
        });
      });

      renderDealsPanel({
        deal: { ...baseDeal, campaigns: [], options: [] },
      });

      fireEvent.click(screen.getByRole("button", { name: "총수수료율 수정" }));
      const input = screen.getByDisplayValue("10");
      fireEvent.change(input, { target: { value: "20" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "저장하기" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "저장하기" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/deal-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ totalCommissionRate: 20, supplyPrice: 12000 }),
          }),
        );
      });
    });

    it("refreshes the option list with the created child option", async () => {
      const onUpdated = vi.fn();

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ entries: [] }),
          });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sellers: [] }),
          });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ outreaches: [] }),
          });
        }
        if (url === "/api/deals" && options?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "opt-1" }),
          });
        }
        if (url === "/api/deals/deal-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                partnerName: baseDeal.partnerName,
                baseMarginPolicy: { byChannel: {} },
                campaigns: [],
                options: [
                  {
                    id: "opt-1",
                    dealName: "3통 구성",
                    costPrice: 30000,
                    sellingPrice: 42000,
                    totalCommissionRate: 10,
                    dealType: "OPTION",
                    optionSortOrder: 0,
                    parentDealId: "deal-1",
                  },
                ],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      });

      renderDealsPanel({
        deal: { ...baseDeal, campaigns: [], options: [] },
        onUpdated,
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.change(screen.getByPlaceholderText("예: 1통"), {
        target: { value: "3통 구성" },
      });
      fireEvent.change(getOptionFormInput("수수료율 (%)"), {
        target: { value: "10" },
      });
      fireEvent.change(getOptionFormInput("공구 판매가 (원)"), {
        target: { value: "42000" },
      });
      fireEvent.click(screen.getByRole("button", { name: "옵션 추가하기" }));

      await waitFor(() => {
        expect(onUpdated).toHaveBeenCalledWith(
          expect.objectContaining({
            options: [
              expect.objectContaining({
                id: "opt-1",
                dealName: "3통 구성",
              }),
            ],
          }),
        );
      });
    });

    it("loads an existing option into edit mode and saves via PATCH", async () => {
      const onUpdated = vi.fn();

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ entries: [] }),
          });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sellers: [] }),
          });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ outreaches: [] }),
          });
        }
        if (url === "/api/deals/opt-1" && options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "opt-1" }),
          });
        }
        if (url === "/api/deals/deal-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                partnerName: baseDeal.partnerName,
                baseMarginPolicy: { byChannel: {} },
                campaigns: [],
                options: [
                  {
                    id: "opt-1",
                    dealName: "6통 구성",
                    costPrice: 37840,
                    sellingPrice: 43000,
                    totalCommissionRate: 12,
                    dealType: "OPTION",
                    optionSortOrder: 0,
                    parentDealId: "deal-1",
                  },
                ],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      });

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [
            {
              id: "opt-1",
              dealName: "3통 구성",
              costPrice: 30000,
              sellingPrice: 42000,
              totalCommissionRate: 10,
              dealType: "OPTION",
              optionSortOrder: 0,
              parentDealId: "deal-1",
            },
          ],
        },
        onUpdated,
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.click(screen.getByRole("button", { name: "테스트 딜 - 3통 구성 수정" }));

      expect(screen.getByText("옵션 수정")).toBeInTheDocument();
      expect(screen.getByDisplayValue("3통 구성")).toBeInTheDocument();

      fireEvent.change(screen.getByDisplayValue("3통 구성"), {
        target: { value: "6통 구성" },
      });
      fireEvent.change(screen.getByDisplayValue("10"), { target: { value: "12" } });
      fireEvent.change(getOptionFormInput("공구 판매가 (원)"), {
        target: { value: "43000" },
      });
      fireEvent.click(screen.getByRole("button", { name: "옵션 수정하기" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/opt-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({
              dealName: "테스트 딜 - 6통 구성",
              unitQuantity: null,
              supplementaryInfo: null,
              costPrice: 37840,
              sellingPrice: 43000,
              totalCommissionRate: 12,
            }),
          }),
        );
      });

      await waitFor(() => {
        expect(onUpdated).toHaveBeenCalledWith(
          expect.objectContaining({
            options: [
              expect.objectContaining({
                id: "opt-1",
                dealName: "6통 구성",
                costPrice: 37840,
                sellingPrice: 43000,
                totalCommissionRate: 12,
              }),
            ],
          }),
        );
      });
    });

    it("reorders options by persisting the full option sequence", async () => {
      const onUpdated = vi.fn();

      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url.includes("/api/activity-log")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ entries: [] }),
          });
        }
        if (url.includes("/api/comments")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([]),
          });
        }
        if (url.includes("/api/deals/deal-1/sellers")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sellers: [] }),
          });
        }
        if (url.includes("/api/outreach")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ outreaches: [] }),
          });
        }
        if (url === "/api/deals/opt-1" && options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "opt-1" }),
          });
        }
        if (url === "/api/deals/opt-2" && options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: "opt-2" }),
          });
        }
        if (url === "/api/deals/deal-1") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ...baseDeal,
                partnerName: baseDeal.partnerName,
                baseMarginPolicy: { byChannel: {} },
                campaigns: [],
                options: [
                  {
                    id: "opt-2",
                    dealName: "2통 구성",
                    costPrice: 20000,
                    sellingPrice: 28000,
                    totalCommissionRate: 10,
                    dealType: "OPTION",
                    optionSortOrder: 0,
                    parentDealId: "deal-1",
                  },
                  {
                    id: "opt-1",
                    dealName: "1통 구성",
                    costPrice: 10000,
                    sellingPrice: 14000,
                    totalCommissionRate: 10,
                    dealType: "OPTION",
                    optionSortOrder: 1,
                    parentDealId: "deal-1",
                  },
                ],
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      });

      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [],
          options: [
            {
              id: "opt-1",
              dealName: "1통 구성",
              costPrice: 10000,
              sellingPrice: 14000,
              totalCommissionRate: 10,
              dealType: "OPTION",
              optionSortOrder: 0,
              parentDealId: "deal-1",
            },
            {
              id: "opt-2",
              dealName: "2통 구성",
              costPrice: 20000,
              sellingPrice: 28000,
              totalCommissionRate: 10,
              dealType: "OPTION",
              optionSortOrder: 1,
              parentDealId: "deal-1",
            },
          ],
        },
        onUpdated,
      });

      fireEvent.click(screen.getByRole("button", { name: /하위 옵션 상품/ }));
      fireEvent.click(screen.getByRole("button", { name: "테스트 딜 - 1통 구성 아래로 이동" }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/opt-2",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ optionSortOrder: 0 }),
          }),
        );
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/deals/opt-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ optionSortOrder: 1 }),
          }),
        );
      });

      await waitFor(() => {
        expect(onUpdated).toHaveBeenCalledWith(
          expect.objectContaining({
            options: [
              expect.objectContaining({ id: "opt-2", optionSortOrder: 0 }),
              expect.objectContaining({ id: "opt-1", optionSortOrder: 1 }),
            ],
          }),
        );
      });
    });
  });

  describe("Linked campaign display and activity log visibility", () => {
    it("renders linked campaign status labels in Korean", async () => {
      renderDealsPanel({
        deal: {
          ...baseDeal,
          campaigns: [
            {
              id: "campaign-1",
              sellerName: "셀러A",
              salesChannel: "공동구매",
              status: "ACTIVE",
              startDate: "2024-01-01T00:00:00Z",
              endDate: "2024-01-03T00:00:00Z",
            },
          ],
        },
      });

      await waitFor(() => {
        expect(screen.getByText("판매 진행 중")).toBeInTheDocument();
      });
    });

    it("keeps activity log collapsed by default", () => {
      renderDealsPanel();

      expect(screen.getByText("활동 기록")).toBeInTheDocument();
      expect(screen.queryByPlaceholderText("아직 활동기록이 없습니다. 메모를 입력하여 첫 기록을 남겨보세요.")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("코멘트를 입력하세요... (@로 멘션)")).not.toBeInTheDocument();
    });
  });
});
