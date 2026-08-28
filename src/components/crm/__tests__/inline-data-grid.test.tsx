import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { InlineDataGrid, type GridColumn } from "../inline-data-grid";

type TestRow = { id: string; name: string; value: string; extra: string };

const defaultColumns: GridColumn<TestRow>[] = [
  { key: "name", label: "이름", width: 150 },
  { key: "value", label: "금액", width: 120 },
  { key: "extra", label: "비고", width: 200 },
];

const defaultRows: TestRow[] = [
  { id: "1", name: "테스트 항목 A", value: "100000", extra: "긴 텍스트 내용이 여기에 들어갑니다" },
  { id: "2", name: "테스트 항목 B", value: "200000", extra: "또 다른 긴 텍스트" },
];

const defaultProps = {
  rows: defaultRows,
  columns: defaultColumns,
  onPatch: vi.fn().mockResolvedValue(null),
};

describe("InlineDataGrid overflow behavior", () => {
  describe("No horizontal overflow on sidebar container (Requirement 7.1, 7.3)", () => {
    it("renders outer container with overflow-hidden to constrain width", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain("overflow-hidden");
    });

    it("applies overflow-x-auto only on the table scroll container, not the outer wrapper", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const outerDiv = container.firstElementChild as HTMLElement;
      // Outer container should NOT have overflow-x-auto
      expect(outerDiv.className).not.toContain("overflow-x-auto");

      // Inner scroll container should have overflow-x-auto
      const scrollContainer = outerDiv.firstElementChild as HTMLElement;
      expect(scrollContainer.className).toContain("overflow-x-auto");
    });

    it("uses table-fixed layout to respect column width constraints", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      expect(table!.className).toContain("table-fixed");
    });

    it("sets w-full on table to fill available width without exceeding it", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const table = container.querySelector("table");
      expect(table!.className).toContain("w-full");
    });
  });

  describe("Minimum column width constraint (Requirement 7.5)", () => {
    it("applies minWidth of 60px on all column headers", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const headerCells = container.querySelectorAll("thead th");
      // Each column header should have minWidth: 60
      headerCells.forEach((th) => {
        const style = (th as HTMLElement).style;
        expect(style.minWidth).toBe("60px");
      });
    });

    it("enforces minimum width even when column width is set below 60px", () => {
      const narrowColumns: GridColumn<TestRow>[] = [
        { key: "name", label: "이름", width: 40 },
        { key: "value", label: "금액", width: 30 },
        { key: "extra", label: "비고", width: 50 },
      ];

      const { container } = render(
        <InlineDataGrid {...defaultProps} columns={narrowColumns} />,
      );

      const headerCells = container.querySelectorAll("thead th");
      headerCells.forEach((th) => {
        const style = (th as HTMLElement).style;
        // minWidth should still be 60px regardless of column width setting
        expect(style.minWidth).toBe("60px");
      });
    });

    it("sets column width via inline style from widths config", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const headerCells = container.querySelectorAll("thead th");
      const firstTh = headerCells[0] as HTMLElement;
      // First column should have width matching the column config
      expect(firstTh.style.width).toBe("150px");
    });
  });

  describe("Text truncation with ellipsis (Requirement 7.4)", () => {
    it("applies overflow-hidden and text-ellipsis on cell content with custom render", () => {
      const columnsWithRender: GridColumn<TestRow>[] = [
        {
          key: "name",
          label: "이름",
          width: 150,
          render: (row) => <span>{row.name}</span>,
        },
        { key: "value", label: "금액", width: 120 },
        { key: "extra", label: "비고", width: 200 },
      ];

      const { container } = render(
        <InlineDataGrid {...defaultProps} columns={columnsWithRender} />,
      );

      // Cells with custom render should have a wrapper div with truncation classes
      const renderWrappers = container.querySelectorAll(
        "td .overflow-hidden.text-ellipsis.whitespace-nowrap",
      );
      expect(renderWrappers.length).toBeGreaterThan(0);
    });

    it("applies truncate class on non-editing cell buttons", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      // Non-editing cells render as buttons with truncate class
      const cellButtons = container.querySelectorAll("td button.truncate");
      expect(cellButtons.length).toBeGreaterThan(0);
    });

    it("applies overflow-hidden on all td elements", () => {
      const { container } = render(<InlineDataGrid {...defaultProps} />);

      const cells = container.querySelectorAll("tbody td");
      cells.forEach((td) => {
        expect((td as HTMLElement).className).toContain("overflow-hidden");
      });
    });
  });

  describe("Sidebar integration constraints", () => {
    it("accepts className prop for additional container styling", () => {
      const { container } = render(
        <InlineDataGrid {...defaultProps} className="custom-sidebar-class" />,
      );

      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain("custom-sidebar-class");
    });

    it("renders correctly with many columns without breaking layout", () => {
      const manyColumns: GridColumn<TestRow>[] = [
        { key: "name", label: "이름", width: 100 },
        { key: "value", label: "금액", width: 100 },
        { key: "extra", label: "비고", width: 100 },
      ];

      const { container } = render(
        <InlineDataGrid {...defaultProps} columns={manyColumns} />,
      );

      // Should still have the constraining structure
      const outerDiv = container.firstElementChild as HTMLElement;
      expect(outerDiv.className).toContain("overflow-hidden");

      const scrollContainer = outerDiv.firstElementChild as HTMLElement;
      expect(scrollContainer.className).toContain("overflow-x-auto");
    });
  });
});
