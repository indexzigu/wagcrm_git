// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PartnersPanel, type PartnerPanelData } from "../partners-panel";
import { dealStatusLabels } from "@/lib/crm-types";

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

const basePartner: PartnerPanelData = {
  id: "partner-1",
  name: "테스트 파트너",
  type: "BRAND",
  contactInfo: "010-1234-5678",
  bankAccount: "국민은행 123-456-789",
  businessNumber: "1234567890",
  notes: "테스트 메모",
  dealCount: 5,
  createdAt: "2024-01-15T00:00:00Z",
  lastContactAt: "2024-06-01T00:00:00Z",
  referredById: null,
  referredByName: null,
  contacts: [],
};

// --- Helper ---

function renderPartnersPanel(
  props: Partial<React.ComponentProps<typeof PartnersPanel>> = {},
) {
  const defaultProps = {
    partner: basePartner,
    open: true,
    onOpenChange: vi.fn(),
    onUpdated: vi.fn(),
  };
  return render(<PartnersPanel {...defaultProps} {...props} />);
}

describe("PartnersPanel", () => {
  const linkedDealFixture = [
    {
      id: "deal-1",
      dealName: "테스트 딜",
      brandName: "테스트 브랜드",
      status: "SOURCING",
      createdAt: "2024-06-01T00:00:00Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
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
      if (url.includes("/api/deals")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ deals: linkedDealFixture }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    });
  });

  describe("Field classification — User_Input vs Auto_Computed (Requirement 6.1)", () => {
    it("renders editable User_Input_Fields with labels", () => {
      renderPartnersPanel();

      expect(screen.getByText("이름")).toBeInTheDocument();
      expect(screen.getByText("유형")).toBeInTheDocument();
      expect(screen.getByText("사업자번호")).toBeInTheDocument();
      expect(screen.getByText("연락처")).toBeInTheDocument();
      expect(screen.getByText("계좌정보")).toBeInTheDocument();
    });

    it("does not render removed fields (Requirement 6.1-6.5)", () => {
      renderPartnersPanel();

      expect(screen.queryByText("메모")).not.toBeInTheDocument();
      expect(screen.queryByText("딜 수")).not.toBeInTheDocument();
      expect(screen.queryByText("등록일")).not.toBeInTheDocument();
      expect(screen.queryByText("최근 컨택")).not.toBeInTheDocument();
      expect(screen.queryByText("소개처")).not.toBeInTheDocument();
    });

    it("renders section header as '회사 정보'", () => {
      renderPartnersPanel();

      expect(screen.getByText("회사 정보")).toBeInTheDocument();
    });

    it("renders type field as select dropdown (Requirement 6.9)", () => {
      renderPartnersPanel();

      // The type field label should be present, and the select trigger shows "브랜드"
      expect(screen.getByText("유형")).toBeInTheDocument();
      // The select trigger should contain the label for BRAND type
      const allBrand = screen.getAllByText("브랜드");
      // At least one is in the select trigger area (InlineEditField select)
      expect(allBrand.length).toBeGreaterThanOrEqual(1);
    });

    it("shows only one 담당자 추가 button when no contacts exist", () => {
      renderPartnersPanel({
        partner: { ...basePartner, contacts: [] },
      });

      expect(screen.getByText("등록된 담당자가 없습니다.")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "담당자 추가" })).toHaveLength(1);
    });

    it("shows only one 딜 연결 button in the detail view", () => {
      renderPartnersPanel();

      const section = screen.getByText("연결된 딜 (0건)").closest("div");
      expect(section).toBeInTheDocument();
      expect(within(section!).getAllByRole("button", { name: "연결" })).toHaveLength(1);
    });

    it("shows linked deal brand info and keeps status/date on one meta row", async () => {
      renderPartnersPanel();

      const brandText = await screen.findByText("테스트 브랜드");
      expect(brandText).toBeInTheDocument();
      expect(brandText.parentElement).toHaveTextContent("브랜드테스트 브랜드");
      expect(brandText.parentElement?.parentElement?.parentElement).toHaveTextContent("테스트 딜");

      const statusBadge = screen.getByText(dealStatusLabels.SOURCING);
      const metaRow = statusBadge.closest("div");
      expect(metaRow).toHaveClass("flex-row");
      expect(metaRow).toHaveTextContent("24-06-01");
    });

  });

  describe("Edit mode transitions (Requirement 6.5)", () => {
    it("switches to edit mode when clicking an editable text field", () => {
      renderPartnersPanel();

      // The contactInfo field has a unique value "010-1234-5678"
      const contactButton = screen.getByText("010-1234-5678").closest("button");
      expect(contactButton).toBeInTheDocument();
      fireEvent.click(contactButton!);

      const input = screen.getByDisplayValue("010-1234-5678");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("010-1234-5678");
    });

    it("pre-fills current value in edit mode for bankAccount", () => {
      renderPartnersPanel();

      const bankButton = screen.getByText("국민은행 123-456-789").closest("button");
      fireEvent.click(bankButton!);

      const input = screen.getByDisplayValue("국민은행 123-456-789");
      expect(input).toHaveValue("국민은행 123-456-789");
    });
  });

  describe("Save behavior (Requirement 6.6)", () => {
    it("saves on blur and calls PATCH API", async () => {
      const onUpdated = vi.fn();
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH" && url.includes("/api/partners/")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ contactInfo: "010-9999-8888" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderPartnersPanel({ onUpdated });

      // Click contactInfo field to enter edit mode
      const contactButton = screen.getByText("010-1234-5678").closest("button");
      fireEvent.click(contactButton!);

      const input = screen.getByDisplayValue("010-1234-5678");
      fireEvent.change(input, { target: { value: "010-9999-8888" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/partners/partner-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ contactInfo: "010-9999-8888" }),
          }),
        );
      });

      await waitFor(() => {
        expect(mockToast.success).not.toHaveBeenCalled();
      });
    });

    it("saves on Enter key press", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ bankAccount: "신한은행 999-888-777" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderPartnersPanel();

      const bankButton = screen.getByText("국민은행 123-456-789").closest("button");
      fireEvent.click(bankButton!);

      const input = screen.getByDisplayValue("국민은행 123-456-789");
      fireEvent.change(input, { target: { value: "신한은행 999-888-777" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/partners/partner-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ bankAccount: "신한은행 999-888-777" }),
          }),
        );
      });
    });
  });

  describe("Cancel behavior (Requirement 6.8)", () => {
    it("cancels edit on Escape key without making API call", async () => {
      renderPartnersPanel();

      const contactButton = screen.getByText("010-1234-5678").closest("button");
      fireEvent.click(contactButton!);

      const input = screen.getByDisplayValue("010-1234-5678");
      fireEvent.change(input, { target: { value: "변경된 번호" } });
      fireEvent.keyDown(input, { key: "Escape" });

      // Should not have called PATCH
      const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCalls.length).toBe(0);

      // Should restore original value
      expect(screen.getByText("010-1234-5678")).toBeInTheDocument();
    });
  });

  describe("API failure rollback (Requirement 6.7)", () => {
    it("reverts to previous value and shows error toast on PATCH failure", async () => {
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (options?.method === "PATCH") {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: "저장 실패" }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderPartnersPanel();

      const contactButton = screen.getByText("010-1234-5678").closest("button");
      fireEvent.click(contactButton!);

      const input = screen.getByDisplayValue("010-1234-5678");
      fireEvent.change(input, { target: { value: "실패할 번호" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("저장 실패");
      });

      // Should revert to original value
      await waitFor(() => {
        expect(screen.getByText("010-1234-5678")).toBeInTheDocument();
      });
    });
  });

  describe("Activity log visibility", () => {
    it("keeps activity log collapsed by default", () => {
      renderPartnersPanel();

      expect(screen.getByText("활동 기록")).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText("아직 활동기록이 없습니다. 메모를 입력하여 첫 기록을 남겨보세요.")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText("코멘트를 입력하세요... (@로 멘션)")
      ).not.toBeInTheDocument();
    });
  });

  describe("Business license file upload renaming", () => {
    it("renames the uploaded file based on the partner name and sends to /api/assets", async () => {
      const uploadBusinessCardOcrFn = vi.fn().mockResolvedValue({ success: true, partner: {} });
      
      let capturedFormData: FormData | null = null;
      global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
        if (url === "/api/assets" && options?.method === "POST") {
          capturedFormData = options.body as FormData;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ asset: { id: "asset-1" } }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        });
      });

      renderPartnersPanel({
        partner: { ...basePartner, name: "테스트/파트너" }, // 특수문자 슬래시 포함
        onUploadBusinessCardOcr: uploadBusinessCardOcrFn,
      });

      const fileInput = document.querySelector("#biz-license-upload") as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();

      const file = new File(["dummy content"], "original_license.png", { type: "image/png" });
      
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith("/api/assets", expect.any(Object));
      });

      expect(capturedFormData).not.toBeNull();
      const uploadedFile = capturedFormData!.get("file") as File;
      expect(uploadedFile).toBeInstanceOf(File);
      // "테스트/파트너" -> 슬래시는 OS 금지문자이므로 "_"로 치환되어 "테스트_파트너_사업자등록증.png"가 됨
      expect(uploadedFile.name).toBe("테스트_파트너_사업자등록증.png");
      expect(capturedFormData!.get("fileName")).toBe("테스트_파트너_사업자등록증.png");
    });
  });
});
