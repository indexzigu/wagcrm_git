// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InlineDataGrid, type GridColumn } from "../inline-data-grid";
import { GroupedTableView } from "../grouped-table-view";
import { SalesZoneTable } from "../sales-zone-table";
import { CategoryTagInput } from "../category-tag-input";
import { CalendarView, type CalendarCampaign } from "../calendar-view";
import { ReviewTable, type PriceSheetRowData } from "../price-sheet/review-table";
import { DealsGrid, type DealRow } from "../deals-grid";
import type { CampaignRow } from "@/lib/crm-types";

// interfaces 점검 묶음 G2(2026-09-24): 표 행·캘린더 바·편집 칸이 `<div onClick>`/`<tr onClick>` 이라
// 포인터로만 열렸다. 이 파일은 각 표면이 **키보드만으로** 같은 동작에 닿는지, 그리고 행 onClick 과
// 새 버튼이 겹쳐 동작이 두 번 돌지 않는지(토글 원위치·이중 열기)를 고정한다.

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "글로우 앰플",
    partnerName: "거래처",
    sellerName: "셀러가",
    snsType: "INSTAGRAM",
    snsHandle: "@seller",
    startDate: "2026-01-01",
    endDate: "2099-12-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "PROPOSAL",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

describe("InlineDataGrid — 행 열기 키보드 경로", () => {
  type Row = { id: string; name: string; memo: string };
  const columns: GridColumn<Row>[] = [
    { key: "name", label: "이름", width: 150 },
    { key: "memo", label: "메모", width: 150 },
  ];
  const rows: Row[] = [{ id: "r1", name: "거래처 A", memo: "비고" }];

  it("onRowClick 이 있으면 첫 칸이 행 열기 버튼이고, Enter 로 한 번만 연다", async () => {
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineDataGrid rows={rows} columns={columns} onPatch={vi.fn()} onRowClick={onRowClick} />,
    );

    const open = screen.getByRole("button", { name: "거래처 A" });
    open.focus();
    await user.keyboard("{Enter}");

    // 행 onClick 과 겹치면 2회가 된다 — stopPropagation 계약.
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    // 첫 칸은 인라인 편집으로 들어가지 않는다(한 칸에 두 동작 금지).
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("render 를 쓰는 첫 칸도 버튼으로 감싼다", async () => {
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineDataGrid
        rows={rows}
        columns={[
          { key: "name", label: "이름", width: 150, render: (row) => <span>{row.name} 표시</span> },
          columns[1],
        ]}
        onPatch={vi.fn()}
        onRowClick={onRowClick}
        disableInlineEdit
      />,
    );

    await user.click(screen.getByRole("button", { name: "거래처 A 표시" }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it("onRowClick 이 없으면 첫 칸은 종전대로 인라인 편집이다", async () => {
    const user = userEvent.setup();
    render(<InlineDataGrid rows={rows} columns={columns} onPatch={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "거래처 A" }));
    expect(screen.getByRole("textbox")).toHaveValue("거래처 A");
  });
});

describe("DealsGrid — 행 열기 버튼 안에는 구문 콘텐츠만", () => {
  // InlineDataGrid 가 첫 칸 render 결과를 「행 열기」 button 으로 감싸므로, 소비처 render 가
  // div 를 돌려주면 button 안 block 요소(무효 HTML)가 된다(교차 검증 지적). 이름은 딜명으로 시작한다.
  it("딜명 칸 button 에 div 가 없고 접근 이름이 딜명으로 시작한다", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const deal = {
      id: "d1",
      dealName: "콜라겐 젤리",
      partnerName: "거래처",
      partnerId: "p1",
      costPrice: 1000,
      sellingPrice: 2000,
      sellerCount: 0,
      status: "ACTIVE",
      campaignCount: 0,
      taskCount: 0,
      createdAt: "2026-01-01T00:00:00Z",
      needsReviewSourceLink: true,
    } as unknown as DealRow;
    render(<DealsGrid initialDeals={[deal]} onSelect={onSelect} />);

    const open = screen.getByRole("button", { name: /^콜라겐 젤리/ });
    expect(open.querySelector("div, p, h1, h2, h3, h4, ul, ol, table")).toBeNull();
    await user.click(open);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("판매 관리 표 — 셀러명 칸 버튼", () => {
  it("GroupedTableView: 셀러명 버튼 Enter 로 상세를 한 번만 연다", async () => {
    const onRowOpen = vi.fn();
    const user = userEvent.setup();
    const campaign = makeCampaign();
    render(
      <GroupedTableView
        campaigns={[campaign]}
        stageFilter="ALL"
        onRowOpen={onRowOpen}
        onRowDelete={vi.fn()}
        onRowDuplicate={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: "셀러가" }).focus();
    await user.keyboard("{Enter}");
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowOpen).toHaveBeenCalledWith(campaign);
  });

  it("SalesZoneTable: 셀러명 버튼 Enter 로 상세를 한 번만 연다", async () => {
    const onRowOpen = vi.fn();
    const user = userEvent.setup();
    const campaign = makeCampaign();
    render(
      <SalesZoneTable campaigns={[campaign]} onRowOpen={onRowOpen} onCampaignUpdate={vi.fn()} />,
    );

    screen.getByRole("button", { name: "셀러가" }).focus();
    await user.keyboard("{Enter}");
    expect(onRowOpen).toHaveBeenCalledTimes(1);
  });
});

describe("CalendarView — 캠페인 바는 버튼이다", () => {
  function campaign(over: Partial<CalendarCampaign> & { id: string }): CalendarCampaign {
    return {
      dealName: `딜-${over.id}`,
      sellerName: "가온",
      sellerId: "s1",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-05T00:00:00.000Z",
      status: "ACTIVE",
      ...over,
    } as CalendarCampaign;
  }

  it("Tab 대상이고 Enter 로 상세 팝오버가 열린다", async () => {
    const user = userEvent.setup();
    render(<CalendarView month="2026-07" campaigns={[campaign({ id: "a" })]} />);

    // 7/1(수)~7/5(일)는 주가 바뀌어 바가 두 조각이다 — 첫 조각으로 본다.
    const bar = screen.getAllByTitle(/^딜-a · 가온 \(/)[0];
    expect(bar.tagName).toBe("BUTTON");
    expect(bar).toHaveAttribute("type", "button");
    expect(bar).toHaveAttribute("aria-expanded", "false");

    bar.focus();
    await user.keyboard("{Enter}");
    expect(bar).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ReviewTable — 편집 칸 키보드 경로", () => {
  function row(overrides: Partial<PriceSheetRowData> = {}): PriceSheetRowData {
    return {
      id: "r1",
      priceSheetId: "sheet-1",
      rowIndex: 0,
      tableSegment: 0,
      productName: "제품A",
      optionName: null,
      sellingPrice: 18000,
      commissionRate: 0.4,
      supplyPrice: null,
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

  it("칸마다 「필드명 편집: 값」 버튼이 있고 Enter 로 입력창이 열린다", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ReviewTable priceSheetId="sheet-1" rows={[row()]} deals={[]} onRowUpdated={() => {}} />
      </TooltipProvider>,
    );

    const product = screen.getByRole("button", { name: /^제품명 편집:\s?제품A$/ });
    // 빈 값도 도달 가능해야 한다 — 이름에 열 이름이 실려 「-」만 읽히지 않는다.
    expect(screen.getByRole("button", { name: /^옵션 편집:\s?-$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^수수료율 편집:\s?40%$/ })).toBeInTheDocument();

    product.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByDisplayValue("제품A")).toHaveFocus();
  });
});

describe("CategoryTagInput — 표시 상태에서 키보드로 편집 시작", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
  });

  it("표시 상태가 버튼이고 Enter 로 편집 입력창에 포커스가 간다", async () => {
    const user = userEvent.setup();
    render(
      <CategoryTagInput
        sellerId="seller-1"
        selectedTags={[{ id: "t1", name: "뷰티" }]}
        onTagsChange={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /카테고리 편집/ });
    expect(within(trigger).getByText("뷰티")).toBeInTheDocument();

    trigger.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "카테고리 입력" })).toHaveFocus());
  });
});
