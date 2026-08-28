// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InlineEditField } from "../inline-edit-field";

// Mock sonner toast
const mockToast = { success: vi.fn(), error: vi.fn() };
type ToastArgs = Parameters<typeof mockToast.success>;
vi.mock("sonner", () => ({
  toast: {
    success: (...args: ToastArgs) => mockToast.success(...args),
    error: (...args: ToastArgs) => mockToast.error(...args),
  },
}));

describe("InlineEditField", () => {
  const defaultProps = {
    label: "판매가",
    value: "50000",
    fieldType: "number" as const,
    onSave: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Computed field rendering (Requirement 6.11)", () => {
    it("renders read-only with '자동' badge when isComputed is true", () => {
      render(
        <InlineEditField
          label="할인율"
          value="12.5"
          displayValue="12.5%"
          fieldType="number"
          isComputed={true}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByText("할인율")).toBeInTheDocument();
      expect(screen.getByText("12.5%")).toBeInTheDocument();
      expect(screen.getByText("자동")).toBeInTheDocument();
    });

    it("does not show edit button for computed fields", () => {
      render(
        <InlineEditField
          label="할인율"
          value="12.5"
          fieldType="number"
          isComputed={true}
          onSave={vi.fn()}
        />,
      );

      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("displays '-' when computed value is empty", () => {
      render(
        <InlineEditField
          label="할인율"
          value=""
          fieldType="number"
          isComputed={true}
          onSave={vi.fn()}
        />,
      );

      expect(screen.getByText("-")).toBeInTheDocument();
    });
  });

  describe("Edit mode transitions (Requirement 6.5)", () => {
    it("renders in display mode by default", () => {
      render(<InlineEditField {...defaultProps} />);

      expect(screen.getByText("50000")).toBeInTheDocument();
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    });

    it("switches to edit mode when clicked", () => {
      render(<InlineEditField {...defaultProps} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue(50000);
    });

    it("pre-fills current value in edit mode", () => {
      render(<InlineEditField {...defaultProps} value="12345" />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      expect(input).toHaveValue(12345);
    });

    it("renders text input for text fieldType", () => {
      render(
        <InlineEditField {...defaultProps} fieldType="text" value="브랜드A" />,
      );

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("textbox");
      expect(input).toBeInTheDocument();
      expect(input).toHaveValue("브랜드A");
    });
  });

  describe("Save behavior (Requirement 6.6)", () => {
    it("saves on blur and shows success toast", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "60000" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(60000);
      });

      await waitFor(() => {
        expect(mockToast.success).not.toHaveBeenCalled();
      });
    });

    it("saves on Enter key press (triggers blur)", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "75000" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // Enter triggers blur in the component
      fireEvent.blur(input);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(75000);
      });
    });

    it("does not save when value is unchanged", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      // Don't change value, just blur
      fireEvent.blur(input);

      // Give time for any async operations
      await new Promise((r) => setTimeout(r, 50));
      expect(onSave).not.toHaveBeenCalled();
    });

    it("saves string value for text fieldType", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(
        <InlineEditField
          {...defaultProps}
          fieldType="text"
          value="old"
          onSave={onSave}
        />,
      );

      fireEvent.click(screen.getByRole("button"));
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "new" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith("new");
      });
    });
  });

  describe("Cancel behavior (Requirement 6.8)", () => {
    it("cancels edit on Escape key without saving", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "99999" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(onSave).not.toHaveBeenCalled();
      // Should return to display mode with original value
      expect(screen.getByText("50000")).toBeInTheDocument();
    });

    it("restores original value after cancel", () => {
      render(
        <InlineEditField {...defaultProps} value="원래값" fieldType="text" />,
      );

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "변경된값" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(screen.getByText("원래값")).toBeInTheDocument();
    });
  });

  describe("API failure rollback (Requirement 6.7)", () => {
    it("reverts to previous value and shows error toast on save failure", async () => {
      const onSave = vi.fn().mockRejectedValue(new Error("네트워크 오류"));
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));

      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "99999" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(99999);
      });

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("네트워크 오류");
      });

      // Should revert to original value in display mode
      await waitFor(() => {
        expect(screen.getByText("50000")).toBeInTheDocument();
      });
    });

    it("shows generic error message when error has no message", async () => {
      const onSave = vi.fn().mockRejectedValue("unknown error");
      render(<InlineEditField {...defaultProps} onSave={onSave} />);

      fireEvent.click(screen.getByRole("button"));
      const input = screen.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "11111" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("저장 실패");
      });
    });
  });

  describe("Validation", () => {
    it("shows validation error and does not save when validate returns error", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      const validate = (val: string) =>
        val === "" ? "값을 입력해주세요" : null;

      render(
        <InlineEditField
          {...defaultProps}
          fieldType="text"
          value="기존값"
          onSave={onSave}
          validate={validate}
        />,
      );

      fireEvent.click(screen.getByRole("button"));
      const input = screen.getByRole("textbox");
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith("값을 입력해주세요");
      });
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe("Select field type", () => {
    const selectProps = {
      label: "파트너 유형",
      value: "BRAND",
      fieldType: "select" as const,
      options: [
        { value: "BRAND", label: "브랜드" },
        { value: "VENDOR", label: "벤더" },
        { value: "AGENCY", label: "에이전시" },
        { value: "AGENT", label: "에이전트" },
      ],
      onSave: vi.fn().mockResolvedValue(undefined),
    };

    it("renders select with current value label", () => {
      render(<InlineEditField {...selectProps} />);
      expect(screen.getByText("브랜드")).toBeInTheDocument();
    });

    it("renders label for select field", () => {
      render(<InlineEditField {...selectProps} />);
      expect(screen.getByText("파트너 유형")).toBeInTheDocument();
    });
  });

  describe("Searchable-select field type", () => {
    const searchableSelectProps = {
      label: "셀러",
      value: "seller-1",
      fieldType: "searchable-select" as const,
      options: [
        { value: "seller-1", label: "김민수" },
        { value: "seller-2", label: "이영희" },
        { value: "seller-3", label: "박지훈" },
      ],
      onSave: vi.fn().mockResolvedValue(undefined),
    };

    it("renders searchable-select with current value label", () => {
      render(<InlineEditField {...searchableSelectProps} />);
      expect(screen.getByText("김민수")).toBeInTheDocument();
    });

    it("renders label for searchable-select field", () => {
      render(<InlineEditField {...searchableSelectProps} />);
      expect(screen.getByText("셀러")).toBeInTheDocument();
    });
  });

  describe("Display value", () => {
    it("uses displayValue when provided", () => {
      render(
        <InlineEditField
          {...defaultProps}
          value="1500000"
          displayValue="150만원"
        />,
      );
      expect(screen.getByText("150만원")).toBeInTheDocument();
    });
  });
});
