// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableDropdown } from "../searchable-dropdown";

type TestItem = { id: string; name: string; handle: string };

const mockItems: TestItem[] = [
  { id: "1", name: "김민수", handle: "@minsu" },
  { id: "2", name: "이영희", handle: "@younghee" },
  { id: "3", name: "박지훈", handle: "@jihoon" },
  { id: "4", name: "한국어테스트", handle: "@korean" },
];

const defaultProps = {
  items: mockItems,
  value: null,
  onValueChange: vi.fn(),
  getSearchableText: (item: TestItem) => `${item.name} ${item.handle}`,
  getLabel: (item: TestItem) => item.name,
  getValue: (item: TestItem) => item.id,
  placeholder: "셀러를 선택하세요",
  emptyMessage: "검색 결과 없음",
};

/**
 * Helper to get the search input inside the Command component.
 * After opening the popover, the cmdk input is rendered with data-slot="command-input".
 */
function getSearchInput() {
  const input = document.querySelector('[cmdk-input]') as HTMLInputElement;
  if (!input) throw new Error("Could not find cmdk input");
  return input;
}

describe("SearchableDropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Rendering", () => {
    it("renders with placeholder when no value is selected", () => {
      render(<SearchableDropdown {...defaultProps} />);
      expect(screen.getByText("셀러를 선택하세요")).toBeInTheDocument();
    });

    it("renders selected item label when value is provided", () => {
      render(<SearchableDropdown {...defaultProps} value="1" />);
      expect(screen.getByText("김민수")).toBeInTheDocument();
    });

    it("renders combobox trigger button", () => {
      render(<SearchableDropdown {...defaultProps} />);
      const trigger = document.querySelector('[data-slot="popover-trigger"]');
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("renders disabled state when disabled prop is true", () => {
      render(<SearchableDropdown {...defaultProps} disabled={true} />);
      const trigger = document.querySelector('[data-slot="popover-trigger"]');
      expect(trigger).toBeDisabled();
    });
  });

  describe("Korean IME handling (Requirement 3.5)", () => {
    it("renders all items when popover is opened (shouldFilter=false)", async () => {
      const user = userEvent.setup();
      render(<SearchableDropdown {...defaultProps} />);

      // Open the dropdown
      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      // All items should be visible
      await waitFor(() => {
        mockItems.forEach((item) => {
          expect(screen.getByText(item.name)).toBeInTheDocument();
        });
      });
    });

    it("filters items using manual filterBySearchText (Korean partial match)", async () => {
      const user = userEvent.setup();
      render(<SearchableDropdown {...defaultProps} />);

      // Open the dropdown
      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      // Wait for popover to open
      await waitFor(() => {
        expect(getSearchInput()).toBeInTheDocument();
      });

      // Type Korean text in search
      const searchInput = getSearchInput();
      fireEvent.change(searchInput, { target: { value: "민수" } });

      // Only matching item should remain visible
      await waitFor(() => {
        expect(screen.getByText("김민수")).toBeInTheDocument();
        expect(screen.queryByText("이영희")).not.toBeInTheDocument();
        expect(screen.queryByText("박지훈")).not.toBeInTheDocument();
      });
    });
  });

  describe("Empty state (Requirement 3.3)", () => {
    it("shows empty message when search matches nothing", async () => {
      const user = userEvent.setup();
      render(<SearchableDropdown {...defaultProps} />);

      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      await waitFor(() => {
        expect(getSearchInput()).toBeInTheDocument();
      });

      // Type text that matches nothing
      const searchInput = getSearchInput();
      fireEvent.change(searchInput, { target: { value: "존재하지않는셀러" } });

      // Should show empty message
      await waitFor(() => {
        expect(screen.getByText("검색 결과 없음")).toBeInTheDocument();
      });
    });

    it("renders custom empty message", async () => {
      const user = userEvent.setup();
      render(
        <SearchableDropdown {...defaultProps} emptyMessage="결과가 없습니다" />,
      );

      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      await waitFor(() => {
        expect(getSearchInput()).toBeInTheDocument();
      });

      const searchInput = getSearchInput();
      fireEvent.change(searchInput, { target: { value: "없는검색어" } });

      await waitFor(() => {
        expect(screen.getByText("결과가 없습니다")).toBeInTheDocument();
      });
    });

    it("restores full list when search is cleared (Requirement 3.4)", async () => {
      const user = userEvent.setup();
      render(<SearchableDropdown {...defaultProps} />);

      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      await waitFor(() => {
        expect(getSearchInput()).toBeInTheDocument();
      });

      const searchInput = getSearchInput();

      // Type to filter
      fireEvent.change(searchInput, { target: { value: "민수" } });
      await waitFor(() => {
        expect(screen.queryByText("이영희")).not.toBeInTheDocument();
      });

      // Clear search
      fireEvent.change(searchInput, { target: { value: "" } });

      // All items should be visible again
      await waitFor(() => {
        mockItems.forEach((item) => {
          expect(screen.getByText(item.name)).toBeInTheDocument();
        });
      });
    });
  });

  describe("Value selection", () => {
    it("falls back to placeholder when value does not match any item", () => {
      render(<SearchableDropdown {...defaultProps} value="nonexistent" />);
      expect(screen.getByText("셀러를 선택하세요")).toBeInTheDocument();
    });

    it("calls onValueChange when an item is selected", async () => {
      const onValueChange = vi.fn();
      const user = userEvent.setup();
      render(
        <SearchableDropdown {...defaultProps} onValueChange={onValueChange} />,
      );

      const trigger = document.querySelector('[data-slot="popover-trigger"]') as HTMLElement;
      await user.click(trigger);

      // Wait for items to render
      await waitFor(() => {
        expect(screen.getByText("이영희")).toBeInTheDocument();
      });

      // Click on an item
      await user.click(screen.getByText("이영희"));

      expect(onValueChange).toHaveBeenCalledWith("2");
    });
  });
});
