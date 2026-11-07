// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineDataGrid, type GridColumn } from "../inline-data-grid";

// [셀러분석] 셀러 비교표 PR-1 — InlineDataGrid 의 선택 열(selectable). 기본은 꺼져 있고,
// 켜면 onDelete 열과 대칭으로 5곳(폭 합·colgroup·thead·스켈레톤·빈 행 colSpan)에 함께 들어간다.

type Row = { id: string; name: string; memo: string };
const columns: GridColumn<Row>[] = [
  { key: "name", label: "이름", width: 150 },
  { key: "memo", label: "메모", width: 120 },
];
const rows: Row[] = [
  { id: "r1", name: "가상 셀러 A", memo: "비고" },
  { id: "r2", name: "가상 셀러 B", memo: "비고" },
];

function tableMinWidth(container: HTMLElement): number {
  return parseInt((container.querySelector("table") as HTMLElement).style.minWidth, 10);
}

describe("InlineDataGrid selectable — 기본값(꺼짐)은 기존 렌더와 같다", () => {
  it("selectable 을 주지 않으면 체크박스·선택 열이 없다", () => {
    const { container } = render(<InlineDataGrid rows={rows} columns={columns} onPatch={vi.fn()} />);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(container.querySelectorAll("col")).toHaveLength(columns.length);
    expect(container.querySelectorAll("thead th")).toHaveLength(columns.length);
    expect(tableMinWidth(container)).toBe(270);
  });
});

describe("InlineDataGrid selectable — 5곳 폭 동기화", () => {
  it("폭 합·colgroup·thead 에 44px 선택 열이 더해진다", () => {
    const { container } = render(
      <InlineDataGrid rows={rows} columns={columns} onPatch={vi.fn()} selectable selectedIds={[]} />,
    );
    expect(tableMinWidth(container)).toBe(270 + 44);
    const cols = container.querySelectorAll("col");
    expect(cols).toHaveLength(columns.length + 1);
    expect((cols[0] as HTMLElement).style.width).toBe("44px");
    expect(container.querySelectorAll("thead th")).toHaveLength(columns.length + 1);
  });

  it("로딩 스켈레톤 행에도 선택 칸이 있다", () => {
    const { container } = render(
      <InlineDataGrid rows={[]} columns={columns} onPatch={vi.fn()} selectable isLoading />,
    );
    const firstRow = container.querySelector("tbody tr") as HTMLElement;
    expect(firstRow.querySelectorAll("td")).toHaveLength(columns.length + 1);
  });

  it("빈 행 colSpan 이 선택 열과 삭제 열을 함께 센다", () => {
    const { container } = render(
      <InlineDataGrid rows={[]} columns={columns} onPatch={vi.fn()} selectable onDelete={vi.fn()} />,
    );
    const cell = container.querySelector("tbody td") as HTMLTableCellElement;
    expect(cell.colSpan).toBe(columns.length + 2);
  });
});

describe("InlineDataGrid selectable — 동작", () => {
  it("체크박스 클릭은 선택만 바꾸고 행을 열지 않는다", async () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineDataGrid
        rows={rows}
        columns={columns}
        onPatch={vi.fn()}
        onRowClick={onRowClick}
        selectable
        selectedIds={["r2"]}
        onSelectionChange={onSelectionChange}
        selectionName={(row) => row.name}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "가상 셀러 A 비교에 담기" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["r2", "r1"]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("선택된 행은 체크돼 있고 옅은 강조색을 받으며, 해제하면 그 id 만 빠진다", async () => {
    const onSelectionChange = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineDataGrid
        rows={rows}
        columns={columns}
        onPatch={vi.fn()}
        selectable
        selectedIds={["r1", "hidden-by-filter"]}
        onSelectionChange={onSelectionChange}
        selectionName={(row) => row.name}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "가상 셀러 A 비교에 담기" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest("tr")!.className).toContain("bg-primary/[0.06]");
    await user.click(box);
    // 필터로 가려진 행의 선택은 그대로 둔다.
    expect(onSelectionChange).toHaveBeenCalledWith(["hidden-by-filter"]);
  });

  it("행 안 Tab 순서: 체크박스 다음에 행 열기 버튼", async () => {
    const user = userEvent.setup();
    render(
      <InlineDataGrid
        rows={[rows[0]]}
        columns={columns}
        onPatch={vi.fn()}
        onRowClick={vi.fn()}
        selectable
        selectedIds={[]}
        selectionName={(row) => row.name}
      />,
    );
    // 머리글 정렬 버튼 뒤, 행 안에서의 순서를 본다.
    const box = screen.getByRole("checkbox", { name: "가상 셀러 A 비교에 담기" });
    box.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "가상 셀러 A" }));
  });

  it("전체 선택 체크박스는 없다", () => {
    render(<InlineDataGrid rows={rows} columns={columns} onPatch={vi.fn()} selectable selectedIds={[]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(rows.length);
  });
});
