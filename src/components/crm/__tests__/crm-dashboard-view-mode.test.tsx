// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/pipeline",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/zone-settings", () => ({
  loadZoneViewMode: vi.fn(() => "VIEW_B"),
  saveZoneViewMode: vi.fn(),
}));

const mockSetStageFilter = vi.fn();
const mockSetTeamFilter = vi.fn();
const mockSetSearchQuery = vi.fn();
const mockSetViewMode = vi.fn();

let mockViewMode: "kanban" | "table" = "kanban";
let mockStageFilter = "ALL";
let mockTeamFilter: string | null = null;
let mockSearchQuery = "";

vi.mock("@/hooks/use-stage-filter", () => ({
  useStageFilter: () => ({
    stageFilter: mockStageFilter,
    setStageFilter: mockSetStageFilter,
    teamFilter: mockTeamFilter,
    setTeamFilter: mockSetTeamFilter,
    searchQuery: mockSearchQuery,
    setSearchQuery: mockSetSearchQuery,
    savedView: "DEFAULT",
    setSavedView: vi.fn(),
    viewMode: mockViewMode,
    setViewMode: mockSetViewMode,
  }),
}));

vi.mock("../campaign-creation-sheet", () => ({ CampaignCreationSheet: () => null }));
vi.mock("../campaign-creation-form", () => ({ CampaignCreationForm: () => null }));
vi.mock("../campaign-side-panel", () => ({ CampaignSidePanel: () => null }));
vi.mock("../floating-action-button", () => ({ FloatingActionButton: () => null }));
vi.mock("../data-source-banner", () => ({ DataSourceBanner: () => null }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button aria-label="사이드바 토글" />,
}));

import { CrmDashboard } from "../crm-dashboard";
import { loadZoneViewMode } from "@/lib/zone-settings";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "Test Deal",
    partnerName: "Partner",
    sellerName: "Seller",
    snsType: "INSTAGRAM",
    snsHandle: "@test",
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
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

function makeInitialData(campaigns: CampaignRow[]): DashboardData {
  return {
    deals: [],
    sellers: [],
    campaigns,
    apiCallLogs: [],
    assets: [],
    storage: {
      supabaseLimitBytes: 1073741824,
      supabaseWarningBytes: 858993459,
      supabaseEstimatedBytes: 0,
      googleDriveConnected: false,
      recentAssets: [],
    },
    teams: [
      { id: "team-1", name: "팀 A" },
      { id: "team-2", name: "팀 B" },
    ],
  };
}

const sampleCampaigns: CampaignRow[] = [
  makeCampaign({ id: "c1", status: "PROPOSAL", sellerName: "셀러1" }),
  makeCampaign({ id: "c2", status: "PREPARATION", sellerName: "셀러2" }),
  makeCampaign({ id: "c3", status: "ACTIVE", sellerName: "셀러3" }),
  makeCampaign({ id: "c4", status: "SETTLEMENT_WAIT", sellerName: "셀러4" }),
];

describe("CrmDashboard view mode switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockViewMode = "kanban";
    mockStageFilter = "ALL";
    mockTeamFilter = null;
    mockSearchQuery = "";
    localStorage.clear();
  });

  it("renders view switcher buttons in header", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    expect(screen.getByRole("button", { name: "칸반" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "테이블" })).toBeInTheDocument();
  });

  it("defaults to kanban active state", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    expect(screen.getByRole("button", { name: "칸반" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "테이블" })).toHaveAttribute("aria-pressed", "false");
  });

  it("loads initial zone mode from local storage helper", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    expect(loadZoneViewMode).toHaveBeenCalled();
  });

  it("calls setViewMode('table') when table button is clicked", async () => {
    const user = userEvent.setup();
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    await user.click(screen.getByRole("button", { name: "테이블" }));
    expect(mockSetViewMode).toHaveBeenCalledWith("table");
  });

  it("calls setViewMode('kanban') when kanban button is clicked", async () => {
    const user = userEvent.setup();
    mockViewMode = "table";
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    await user.click(screen.getByRole("button", { name: "칸반" }));
    expect(mockSetViewMode).toHaveBeenCalledWith("kanban");
  });

  it("renders stage filter controls in kanban mode", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    const filterGroup = screen.getByRole("group", { name: "단계 필터" });
    expect(within(filterGroup).getByText("전체")).toBeInTheDocument();
    expect(within(filterGroup).getByText("영업")).toBeInTheDocument();
    expect(within(filterGroup).getByText("진행")).toBeInTheDocument();
    expect(within(filterGroup).getByText("정산")).toBeInTheDocument();
  });

  it("does not reset filters while switching view mode", async () => {
    const user = userEvent.setup();
    mockStageFilter = "PROGRESS";
    mockTeamFilter = "team-1";
    mockSearchQuery = "셀러";

    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    await user.click(screen.getByRole("button", { name: "테이블" }));

    expect(mockSetStageFilter).not.toHaveBeenCalled();
    expect(mockSetTeamFilter).not.toHaveBeenCalled();
    expect(mockSetSearchQuery).not.toHaveBeenCalled();
  });
});
