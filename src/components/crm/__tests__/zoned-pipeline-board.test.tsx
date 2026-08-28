import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ZonedPipelineBoard } from "../zoned-pipeline-board";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import type { ZoneCollapseState } from "@/lib/zone-settings";

// ---------------------------------------------------------------------------
// Mock sonner toast
// ---------------------------------------------------------------------------

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: `camp-${Math.random().toString(36).slice(2, 8)}`,
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "테스트 딜 테스트 셀러",
    dealName: "테스트 딜",
    partnerName: "테스트 파트너",
    sellerName: "테스트 셀러",
    snsType: "INSTAGRAM",
    snsHandle: "@test",
    startDate: "2024-01-15",
    endDate: "2024-02-15",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 15,
    netMarginRate: 15,
    status: "PROPOSAL" as CampaignStatus,
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2024-01-15T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  };
}

function makeCampaigns(): CampaignRow[] {
  return [
    makeCampaign({ id: "c1", status: "PROPOSAL", dealName: "영업 딜 1" }),
    makeCampaign({ id: "c2", status: "PROPOSAL", dealName: "영업 딜 2" }),
    makeCampaign({ id: "c3", status: "PREPARATION", dealName: "진행 딜 1" }),
    makeCampaign({ id: "c4", status: "ACTIVE", dealName: "진행 딜 2" }),
    makeCampaign({ id: "c5", status: "CLOSED", dealName: "진행 딜 3" }),
    makeCampaign({ id: "c6", status: "SETTLEMENT_IN_PROGRESS", dealName: "정산 딜 1" }),
    makeCampaign({ id: "c7", status: "COMPLETED", dealName: "정산 딜 2" }),
  ];
}

const defaultCollapseState: ZoneCollapseState = {
  SALES: true,
  DEAL_EXECUTION: true,
  SETTLEMENT: true,
};

const defaultProps = {
  campaigns: makeCampaigns(),
  zoneCollapseState: defaultCollapseState,
  salesZoneViewMode: "kanban" as const,
  onZoneCollapseChange: vi.fn(),
  onSalesZoneViewModeChange: vi.fn(),
  onRowOpen: vi.fn(),
  onRowDelete: vi.fn(),
  onRowDuplicate: vi.fn(),
  onStatusChange: vi.fn().mockResolvedValue(undefined),
  onAddCampaign: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ZonedPipelineBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Zone dividers render between correct columns (Requirement 2.1)", () => {
    it("renders 3 zone sections in order: SALES, DEAL_EXECUTION, SETTLEMENT", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      const salesSection = screen.getByTestId("zone-section-SALES");
      const dealSection = screen.getByTestId("zone-section-DEAL_EXECUTION");
      const settlementSection = screen.getByTestId("zone-section-SETTLEMENT");

      expect(salesSection).toBeInTheDocument();
      expect(dealSection).toBeInTheDocument();
      expect(settlementSection).toBeInTheDocument();
    });

    it("renders ZoneDivider with correct labels for each zone", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      expect(screen.getByText("영업")).toBeInTheDocument();
      expect(screen.getByText("딜 진행")).toBeInTheDocument();
      expect(screen.getByText("정산")).toBeInTheDocument();
    });

    it("renders correct campaign counts in zone dividers", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      // SALES zone: 2 campaigns (PROPOSAL)
      const salesSection = screen.getByTestId("zone-section-SALES");
      expect(within(salesSection).getByText("2")).toBeInTheDocument();

      // DEAL_EXECUTION zone: 3 campaigns (PREPARATION, ACTIVE, CLOSED)
      const dealSection = screen.getByTestId("zone-section-DEAL_EXECUTION");
      expect(within(dealSection).getByText("3")).toBeInTheDocument();

      // SETTLEMENT zone: 2 campaigns (SETTLEMENT_WAIT, COMPLETED)
      const settlementSection = screen.getByTestId("zone-section-SETTLEMENT");
      expect(within(settlementSection).getByText("2")).toBeInTheDocument();
    });

    it("renders zone sections in correct DOM order", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      const board = screen.getByTestId("zoned-pipeline-board");
      const sections = within(board).getAllByTestId(/^zone-section-/);

      expect(sections[0]).toHaveAttribute("data-testid", "zone-section-SALES");
      expect(sections[1]).toHaveAttribute("data-testid", "zone-section-DEAL_EXECUTION");
      expect(sections[2]).toHaveAttribute("data-testid", "zone-section-SETTLEMENT");
    });
  });

  describe("Collapse/expand toggles zone visibility (Requirement 3.3, 3.4)", () => {
    it("renders collapse control for each zone", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      expect(screen.getByTestId("zone-collapse-SALES")).toBeInTheDocument();
      expect(screen.getByTestId("zone-collapse-DEAL_EXECUTION")).toBeInTheDocument();
      expect(screen.getByTestId("zone-collapse-SETTLEMENT")).toBeInTheDocument();
    });

    it("collapse control has aria-expanded=true when zone is expanded", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      const salesCollapse = screen.getByTestId("zone-collapse-SALES");
      expect(salesCollapse).toHaveAttribute("aria-expanded", "true");
    });

    it("collapse control has aria-expanded=false when zone is collapsed", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: true,
      };

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
        />,
      );

      const salesCollapse = screen.getByTestId("zone-collapse-SALES");
      expect(salesCollapse).toHaveAttribute("aria-expanded", "false");
    });

    it("clicking collapse control calls onZoneCollapseChange with toggled state", () => {
      const onZoneCollapseChange = vi.fn();

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          onZoneCollapseChange={onZoneCollapseChange}
        />,
      );

      const salesCollapse = screen.getByTestId("zone-collapse-SALES");
      fireEvent.click(salesCollapse);

      expect(onZoneCollapseChange).toHaveBeenCalledWith({
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: true,
      });
    });

    it("shows zone content when expanded", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      expect(screen.getByTestId("zone-content-SALES")).toBeInTheDocument();
      expect(screen.getByTestId("zone-content-DEAL_EXECUTION")).toBeInTheDocument();
      expect(screen.getByTestId("zone-content-SETTLEMENT")).toBeInTheDocument();
    });

    it("hides zone content when collapsed", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
        />,
      );

      expect(screen.queryByTestId("zone-content-SALES")).not.toBeInTheDocument();
      expect(screen.getByTestId("zone-content-DEAL_EXECUTION")).toBeInTheDocument();
      expect(screen.queryByTestId("zone-content-SETTLEMENT")).not.toBeInTheDocument();
    });
  });

  describe("Collapsed zone shows count only (Requirement 3.4)", () => {
    it("displays campaign count text when zone is collapsed", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
        />,
      );

      // SALES collapsed: 2 campaigns
      const salesCollapsed = screen.getByTestId("zone-collapsed-SALES");
      expect(salesCollapsed).toHaveTextContent("2건");

      // SETTLEMENT collapsed: 2 campaigns
      const settlementCollapsed = screen.getByTestId("zone-collapsed-SETTLEMENT");
      expect(settlementCollapsed).toHaveTextContent("2건");
    });

    it("does not show collapsed indicator when zone is expanded", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      expect(screen.queryByTestId("zone-collapsed-SALES")).not.toBeInTheDocument();
      expect(screen.queryByTestId("zone-collapsed-DEAL_EXECUTION")).not.toBeInTheDocument();
      expect(screen.queryByTestId("zone-collapsed-SETTLEMENT")).not.toBeInTheDocument();
    });

    it("blocks collapsing the last expanded zone", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };
      const onZoneCollapseChange = vi.fn();

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
          onZoneCollapseChange={onZoneCollapseChange}
        />,
      );

      // DEAL_EXECUTION is the last expanded zone — collapse should be blocked
      const dealCollapse = screen.getByTestId("zone-collapse-DEAL_EXECUTION");
      fireEvent.click(dealCollapse);

      expect(onZoneCollapseChange).not.toHaveBeenCalled();
    });

    it("disables the collapse button for the last expanded zone", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
        />,
      );

      const dealCollapse = screen.getByTestId("zone-collapse-DEAL_EXECUTION");
      expect(dealCollapse).toBeDisabled();
    });
  });

  describe("Sales Zone table/kanban toggle (Requirement 4.1)", () => {
    it("renders table/kanban toggle when Sales Zone is expanded", () => {
      render(<ZonedPipelineBoard {...defaultProps} />);

      expect(screen.getByTestId("sales-zone-kanban-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("sales-zone-table-toggle")).toBeInTheDocument();
    });

    it("does not render table/kanban toggle when Sales Zone is collapsed", () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: true,
      };

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
        />,
      );

      expect(screen.queryByTestId("sales-zone-kanban-toggle")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sales-zone-table-toggle")).not.toBeInTheDocument();
    });

    it("kanban toggle has aria-pressed=true when in kanban mode", () => {
      render(
        <ZonedPipelineBoard {...defaultProps} salesZoneViewMode="kanban" />,
      );

      const kanbanToggle = screen.getByTestId("sales-zone-kanban-toggle");
      expect(kanbanToggle).toHaveAttribute("aria-pressed", "true");
    });

    it("table toggle has aria-pressed=true when in table mode", () => {
      render(
        <ZonedPipelineBoard {...defaultProps} salesZoneViewMode="table" />,
      );

      const tableToggle = screen.getByTestId("sales-zone-table-toggle");
      expect(tableToggle).toHaveAttribute("aria-pressed", "true");
    });

    it("clicking table toggle calls onSalesZoneViewModeChange with 'table'", () => {
      const onSalesZoneViewModeChange = vi.fn();

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          salesZoneViewMode="kanban"
          onSalesZoneViewModeChange={onSalesZoneViewModeChange}
        />,
      );

      fireEvent.click(screen.getByTestId("sales-zone-table-toggle"));
      expect(onSalesZoneViewModeChange).toHaveBeenCalledWith("table");
    });

    it("clicking kanban toggle calls onSalesZoneViewModeChange with 'kanban'", () => {
      const onSalesZoneViewModeChange = vi.fn();

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          salesZoneViewMode="table"
          onSalesZoneViewModeChange={onSalesZoneViewModeChange}
        />,
      );

      fireEvent.click(screen.getByTestId("sales-zone-kanban-toggle"));
      expect(onSalesZoneViewModeChange).toHaveBeenCalledWith("kanban");
    });

    it("renders SalesZoneTable when in table mode", () => {
      render(
        <ZonedPipelineBoard {...defaultProps} salesZoneViewMode="table" />,
      );

      // SalesZoneTable renders a region with aria-label "영업 존 테이블"
      expect(screen.getByRole("region", { name: "영업 존 테이블" })).toBeInTheDocument();
    });

    it("renders campaign cards when in kanban mode", () => {
      render(
        <ZonedPipelineBoard {...defaultProps} salesZoneViewMode="kanban" />,
      );

      // Should not render the table
      expect(screen.queryByRole("region", { name: "영업 존 테이블" })).not.toBeInTheDocument();
    });
  });

  describe("DnD into collapsed zone updates count (Requirement 3.6, 3.7)", () => {
    it("accepts drop on collapsed zone and triggers status change", async () => {
      const collapseState: ZoneCollapseState = {
        SALES: false,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };
      const onStatusChange = vi.fn().mockResolvedValue(undefined);

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
          onStatusChange={onStatusChange}
        />,
      );

      const settlementSection = screen.getByTestId("zone-section-SETTLEMENT");

      // Simulate drag and drop
      const dataTransfer = {
        getData: () => "c3", // PREPARATION campaign
        dropEffect: "move",
      };

      fireEvent.dragOver(settlementSection, { dataTransfer });
      fireEvent.drop(settlementSection, { dataTransfer });

      // Should call onStatusChange with the default status for SETTLEMENT zone
      expect(onStatusChange).toHaveBeenCalledWith("c3", "SETTLEMENT_IN_PROGRESS");
    });

    it("updates count optimistically after drop into collapsed zone", async () => {
      const collapseState: ZoneCollapseState = {
        SALES: true,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };
      const onStatusChange = vi.fn().mockResolvedValue(undefined);

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
          onStatusChange={onStatusChange}
        />,
      );

      const settlementSection = screen.getByTestId("zone-section-SETTLEMENT");

      // Before drop: Settlement has 2 campaigns
      const collapsedBefore = screen.getByTestId("zone-collapsed-SETTLEMENT");
      expect(collapsedBefore).toHaveTextContent("2건");

      // Simulate drop of a DEAL_EXECUTION campaign into SETTLEMENT
      const dataTransfer = {
        getData: () => "c3", // PREPARATION campaign
        dropEffect: "move",
      };

      fireEvent.dragOver(settlementSection, { dataTransfer });
      fireEvent.drop(settlementSection, { dataTransfer });

      // After optimistic update: Settlement should show 3
      const collapsedAfter = screen.getByTestId("zone-collapsed-SETTLEMENT");
      expect(collapsedAfter).toHaveTextContent("3건");
    });

    it("does not expand collapsed zone after drop", () => {
      const collapseState: ZoneCollapseState = {
        SALES: true,
        DEAL_EXECUTION: true,
        SETTLEMENT: false,
      };
      const onZoneCollapseChange = vi.fn();

      render(
        <ZonedPipelineBoard
          {...defaultProps}
          zoneCollapseState={collapseState}
          onZoneCollapseChange={onZoneCollapseChange}
        />,
      );

      const settlementSection = screen.getByTestId("zone-section-SETTLEMENT");

      const dataTransfer = {
        getData: () => "c3",
        dropEffect: "move",
      };

      fireEvent.dragOver(settlementSection, { dataTransfer });
      fireEvent.drop(settlementSection, { dataTransfer });

      // Zone collapse state should NOT be changed (zone stays collapsed)
      expect(onZoneCollapseChange).not.toHaveBeenCalled();
    });
  });
});
