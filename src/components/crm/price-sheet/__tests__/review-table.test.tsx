import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewTable } from "../review-table";
import type { PriceSheetRowData } from "../review-table";

// ReviewTable의 「원본」 셀은 Tooltip을 쓰므로 TooltipProvider 컨텍스트가 필요하다
// (radix-ui의 useContext 요구사항 — 실제 페이지도 루트 레이아웃에서 항상 제공됨).
function renderTable(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function renderWithUser(ui: React.ReactElement) {
  const user = userEvent.setup();
  return { user, ...renderTable(ui) };
}

function row(overrides: Partial<PriceSheetRowData> = {}): PriceSheetRowData {
  return {
    id: "row",
    priceSheetId: "sheet-1",
    rowIndex: 0,
    tableSegment: 0,
    productName: "제품A",
    optionName: "젤리 2팩",
    sellingPrice: 18000,
    commissionRate: 0.4,
    supplyPrice: 10800,
    listPrice: null,
    floorPrice: null,
    discountRate: null,
    note: null,
    flags: null,
    rawCells: {},
    mappingStatus: "NEW_DEAL",
    mappedDealId: null,
    ...overrides,
  };
}

describe("ReviewTable — 묶음 제외 열", () => {
  it("bundleMode 미전달 시(AUTO 경로) 제외 열이 렌더되지 않는다", () => {
    renderTable(
      <ReviewTable
        priceSheetId="sheet-1"
        rows={[row({ id: "r1" })]}
        deals={[]}
        onRowUpdated={() => {}}
      />
    );

    const headerRow = screen.getAllByRole("row")[0];
    const headers = within(headerRow).getAllByRole("columnheader");
    // 제품명·옵션·판매가·공급가·정상가·최저가·수수료율(%)·할인율(%)·플래그·매핑·원본·삭제(sr-only) = 12열
    expect(headers).toHaveLength(12);
    expect(screen.queryByText("묶음 제외")).not.toBeInTheDocument();

    const bodyRow = screen.getAllByRole("row")[1];
    const cells = within(bodyRow).getAllByRole("cell");
    expect(cells).toHaveLength(12);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("bundleMode가 true면 각 행에 제외 체크박스가 렌더된다", () => {
    renderTable(
      <ReviewTable
        priceSheetId="sheet-1"
        rows={[row({ id: "r1" }), row({ id: "r2", productName: "제품B" })]}
        deals={[]}
        onRowUpdated={() => {}}
        bundleMode
      />
    );

    expect(screen.getByText("묶음 제외")).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
  });

  it("체크박스를 클릭하면 해당 행 id로 onToggleExclude가 호출된다", async () => {
    const onToggleExclude = vi.fn();
    const { user } = renderWithUser(
      <ReviewTable
        priceSheetId="sheet-1"
        rows={[row({ id: "r1" }), row({ id: "r2", productName: "제품B" })]}
        deals={[]}
        onRowUpdated={() => {}}
        bundleMode
        onToggleExclude={onToggleExclude}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]);

    expect(onToggleExclude).toHaveBeenCalledTimes(1);
    expect(onToggleExclude).toHaveBeenCalledWith("r2");
  });

  it("excludedRowIds에 포함된 행은 체크 상태로, 미전달 시 모두 미체크로 렌더된다", () => {
    renderTable(
      <ReviewTable
        priceSheetId="sheet-1"
        rows={[row({ id: "r1" }), row({ id: "r2", productName: "제품B" })]}
        deals={[]}
        onRowUpdated={() => {}}
        bundleMode
        excludedRowIds={["r2"]}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(false);
    expect(checkboxes[1].checked).toBe(true);
  });

  it("excludedRowIds를 아예 전달하지 않아도 체크박스는 모두 미체크로 렌더된다(controlled 값이 undefined로 새지 않음)", () => {
    renderTable(
      <ReviewTable
        priceSheetId="sheet-1"
        rows={[row({ id: "r1" }), row({ id: "r2", productName: "제품B" })]}
        deals={[]}
        onRowUpdated={() => {}}
        bundleMode
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.every((c) => c.checked === false)).toBe(true);
  });
});
