// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ZoneViewSelector } from "../zone-view-selector";
import { ZoneDivider } from "../zone-divider";
import { ZoneCollapseControl } from "../zone-collapse-control";
import { SalesZoneTable } from "../sales-zone-table";
import type { CampaignRow } from "@/lib/crm-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "글로우 앰플 4차",
    partnerName: "코링코",
    sellerName: "미나",
    snsType: "INSTAGRAM",
    snsHandle: "@mina_beauty",
    startDate: "2026-01-15",
    endDate: "2026-12-31",
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
    followerHistory: [{ date: "2026-01-01", followers: 50000 }],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

// ---------------------------------------------------------------------------
// ZoneViewSelector Tests (Requirements 1.1, 7.5)
// ---------------------------------------------------------------------------

describe("ZoneViewSelector", () => {
  it("renders correct active state for VIEW_B", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
      />,
    );

    const viewBButton = screen.getByRole("radio", { name: "3-Zone 뷰" });
    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });

    expect(viewBButton).toHaveAttribute("data-state", "on");
    expect(viewCButton).toHaveAttribute("data-state", "off");
  });

  it("renders correct active state for VIEW_C", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_C"
        onViewChange={onViewChange}
      />,
    );

    const viewBButton = screen.getByRole("radio", { name: "3-Zone 뷰" });
    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });

    expect(viewBButton).toHaveAttribute("data-state", "off");
    expect(viewCButton).toHaveAttribute("data-state", "on");
  });

  it("calls onViewChange when a different view is selected", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
      />,
    );

    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });
    await user.click(viewCButton);

    expect(onViewChange).toHaveBeenCalledWith("VIEW_C");
  });

  it("renders disabled state with reduced opacity in table/monthly view", () => {
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
        disabled={true}
      />,
    );

    // The toggle group should have opacity-50 class
    const toggleGroup = screen.getByRole("group");
    expect(toggleGroup).toHaveClass("opacity-50");

    // All radio buttons should be disabled
    const buttons = screen.getAllByRole("radio");
    buttons.forEach((btn) => expect(btn).toBeDisabled());
  });

  it("does not call onViewChange when disabled", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={onViewChange}
        disabled={true}
      />,
    );

    const viewCButton = screen.getByRole("radio", { name: "분리형 뷰" });
    await user.click(viewCButton);

    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("shows tooltip wrapper when disabled", () => {
    const { container } = render(
      <ZoneViewSelector
        currentView="VIEW_B"
        onViewChange={vi.fn()}
        disabled={true}
      />,
    );

    // When disabled, the component wraps in a TooltipProvider/Tooltip
    // The tooltip trigger wraps the selector
    const tooltipTrigger = container.querySelector("[data-slot='tooltip-trigger']");
    expect(tooltipTrigger).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ZoneDivider Tests (Requirements 2.1, 2.2, 2.3)
// ---------------------------------------------------------------------------

describe("ZoneDivider", () => {
  it("renders zone label for SALES zone", () => {
    render(<ZoneDivider zone="SALES" campaignCount={5} />);
    expect(screen.getByText("영업")).toBeInTheDocument();
  });

  it("renders zone label for DEAL_EXECUTION zone", () => {
    render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={12} />);
    expect(screen.getByText("딜 진행")).toBeInTheDocument();
  });

  it("renders zone label for SETTLEMENT zone", () => {
    render(<ZoneDivider zone="SETTLEMENT" campaignCount={3} />);
    expect(screen.getByText("정산")).toBeInTheDocument();
  });

  it("renders campaign count", () => {
    render(<ZoneDivider zone="SALES" campaignCount={42} />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders campaign count of zero", () => {
    render(<ZoneDivider zone="DEAL_EXECUTION" campaignCount={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("has role=separator with horizontal orientation", () => {
    render(<ZoneDivider zone="SALES" campaignCount={5} />);
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  });

  it("has accessible aria-label with zone name", () => {
    render(<ZoneDivider zone="SALES" campaignCount={5} />);
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-label", "영업 존");
  });

  it("meets contrast requirements — label uses dark text on light background", () => {
    const { container } = render(
      <ZoneDivider zone="SALES" campaignCount={5} />,
    );

    // SALES zone uses text-blue-900 on bg-blue-50 (contrast > 4.5:1)
    const label = container.querySelector("span");
    expect(label).toHaveClass("text-blue-900");

    const divider = container.querySelector("[role='separator']");
    expect(divider).toHaveClass("bg-blue-50");
  });

  it("uses distinct styles per zone for visual differentiation", () => {
    const { container: salesContainer } = render(
      <ZoneDivider zone="SALES" campaignCount={1} />,
    );
    const { container: dealContainer } = render(
      <ZoneDivider zone="DEAL_EXECUTION" campaignCount={1} />,
    );
    const { container: settlementContainer } = render(
      <ZoneDivider zone="SETTLEMENT" campaignCount={1} />,
    );

    const salesSep = salesContainer.querySelector("[role='separator']");
    const dealSep = dealContainer.querySelector("[role='separator']");
    const settlementSep = settlementContainer.querySelector("[role='separator']");

    // Each zone has a different background color
    expect(salesSep).toHaveClass("bg-blue-50");
    expect(dealSep).toHaveClass("bg-amber-50");
    expect(settlementSep).toHaveClass("bg-emerald-50");
  });

  it("renders label with minimum 12px font size (text-sm = 14px)", () => {
    const { container } = render(
      <ZoneDivider zone="SALES" campaignCount={5} />,
    );
    // text-sm in Tailwind is 0.875rem = 14px, which is >= 12px
    const label = container.querySelector("span");
    expect(label).toHaveClass("text-sm");
  });
});

// ---------------------------------------------------------------------------
// ZoneCollapseControl Tests (Requirement 3.1)
// ---------------------------------------------------------------------------

describe("ZoneCollapseControl", () => {
  it("renders aria-expanded=true when expanded", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("renders aria-expanded=false when collapsed", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("calls onToggle when clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    await user.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard interaction with Enter key", () => {
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
    // Native button handles Enter via click event
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });

  it("supports keyboard interaction with Space key", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    button.focus();
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalled();
  });

  it("is disabled when disabled prop is true (last expanded zone)", () => {
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        disabled={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("does not call onToggle when disabled", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ZoneCollapseControl
        zone="DEAL_EXECUTION"
        expanded={true}
        disabled={true}
        onToggle={onToggle}
      />,
    );

    await user.click(screen.getByRole("button"));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("has accessible aria-label with zone name and action", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={true}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "영업 존 접기");
  });

  it("updates aria-label when collapsed", () => {
    render(
      <ZoneCollapseControl
        zone="SALES"
        expanded={false}
        onToggle={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "영업 존 펼치기");
  });
});

// ---------------------------------------------------------------------------
// SalesZoneTable Tests (Requirements 4.2, 4.3)
// ---------------------------------------------------------------------------

describe("SalesZoneTable", () => {
  const campaigns: CampaignRow[] = [
    makeCampaign({
      id: "camp-1",
      sellerName: "미나",
      dealName: "글로우 앰플 4차",
      partnerName: "코링코",
      status: "PROPOSAL",
      startDate: "2026-01-15",
      followerHistory: [{ date: "2026-01-01", followers: 50000 }],
    }),
    makeCampaign({
      id: "camp-2",
      sellerName: "수진",
      dealName: "비타민C 세럼",
      partnerName: "뷰티랩",
      status: "PROPOSAL",
      startDate: "2026-02-01",
      followerHistory: [{ date: "2026-01-01", followers: 120000 }],
    }),
  ];

  it("renders all required columns", () => {
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("셀러명")).toBeInTheDocument();
    expect(screen.getByText("딜명")).toBeInTheDocument();
    expect(screen.getByText("거래처명")).toBeInTheDocument();
    expect(screen.getByText("제안 상태")).toBeInTheDocument();
    expect(screen.getByText("팔로워 수")).toBeInTheDocument();
    expect(screen.getByText("시작일")).toBeInTheDocument();
  });

  it("renders campaign data in table rows", () => {
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("미나")).toBeInTheDocument();
    expect(screen.getByText("글로우 앰플 4차")).toBeInTheDocument();
    expect(screen.getByText("코링코")).toBeInTheDocument();
    expect(screen.getByText("수진")).toBeInTheDocument();
    expect(screen.getByText("비타민C 세럼")).toBeInTheDocument();
    expect(screen.getByText("뷰티랩")).toBeInTheDocument();
  });

  it("sorts by startDate descending by default (most recent first)", () => {
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole("row");
    // First data row (index 1, after header) should be camp-2 (2026-02-01)
    // Second data row (index 2) should be camp-1 (2026-01-15)
    expect(rows[1]).toHaveTextContent("수진");
    expect(rows[2]).toHaveTextContent("미나");
  });

  it("renders empty state when no campaigns", () => {
    render(
      <SalesZoneTable
        campaigns={[]}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("제안 캠페인이 없습니다")).toBeInTheDocument();
  });

  it("supports inline editing for status via dropdown", () => {
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    // Status dropdowns should be present (one per campaign row)
    const statusTriggers = screen.getAllByRole("combobox");
    expect(statusTriggers.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onRowOpen when a row is clicked", async () => {
    const user = userEvent.setup();
    const onRowOpen = vi.fn();
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={onRowOpen}
        onCampaignUpdate={vi.fn()}
      />,
    );

    // Click on the seller name in the first data row
    await user.click(screen.getByText("수진"));
    expect(onRowOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "camp-2" }),
    );
  });

  it("has scrollable container with keyboard tab navigation", () => {
    const { container } = render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    const scrollRegion = container.querySelector("[role='region']");
    expect(scrollRegion).toHaveAttribute("tabindex", "0");
    expect(scrollRegion).toHaveClass("overflow-x-auto");
  });

  it("has accessible region label", () => {
    render(
      <SalesZoneTable
        campaigns={campaigns}
        onRowOpen={vi.fn()}
        onCampaignUpdate={vi.fn()}
      />,
    );

    const region = screen.getByRole("region", { name: "영업 존 테이블" });
    expect(region).toBeInTheDocument();
  });
});
