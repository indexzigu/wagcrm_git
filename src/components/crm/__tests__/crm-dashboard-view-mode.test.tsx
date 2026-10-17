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

  it("renders view switcher as CrmShell header segments", () => {
    const { container } = render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    const header = container.querySelector("header") as HTMLElement;

    const group = within(header).getByRole("radiogroup", { name: "보기 전환" });
    expect(within(group).getByRole("radio", { name: "칸반" })).toBeInTheDocument();
    expect(within(group).getByRole("radio", { name: "테이블" })).toBeInTheDocument();
  });

  it("puts the primary 캠페인 등록 action in the header, not in the card row", () => {
    const { container } = render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    const header = container.querySelector("header") as HTMLElement;
    expect(within(header).getByRole("button", { name: "캠페인 등록" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "캠페인 등록" })).toHaveLength(1);
  });

  it("merges search and 조합 캠페인 into the stage filter row (no separate control row)", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);
    const filterGroup = screen.getByRole("group", { name: "단계 필터" });
    // 단계 칩과 검색·조합 캠페인이 **한 가로줄**(칩 왼쪽, 조작 오른쪽)이어야 한다 — 종전엔 조작만 담긴
    // 별도 줄이 칩 위에 있었다(제목을 셸 머리로 올린 뒤 빈 줄로 남음).
    const row = filterGroup.parentElement as HTMLElement;
    expect(row.className).toContain("justify-between");
    expect(row.className).not.toContain("flex-col");
    expect(within(row).getByRole("textbox", { name: "캠페인 검색" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /조합 캠페인/ })).toBeInTheDocument();
  });

  it("/pipeline(진행 고정·칸반): 검색·조합 캠페인은 실행 보드의 빠른 필터 줄 오른쪽에 붙고, 조작만 담긴 줄은 없다", () => {
    mockStageFilter = "PROGRESS";
    const { container } = render(
      <CrmDashboard initialData={makeInitialData(sampleCampaigns)} lockedStageFilter="PROGRESS" />,
    );
    const quick = screen.getByRole("button", { name: /^전체 처리/ });
    const toolbar = quick.parentElement!.parentElement as HTMLElement;
    expect(within(toolbar).getByRole("textbox", { name: "캠페인 검색" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /조합 캠페인/ })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: "캠페인 검색" })).toHaveLength(1);
    // 카드 머리의 조작 줄(border-b 묶음)이 비어 남지 않는다 — 필터가 없으면 아예 그리지 않는다.
    expect(container.querySelector('[data-slot="pipeline-card-head"]')).toBeNull();
  });

  it("실행 보드에서 필터 결과가 비면 검색칸 왼쪽에 「조건에 맞는 캠페인 없음」·초기화를 붙이고, 보드 위에 새 줄을 띄우지 않는다", () => {
    mockStageFilter = "PROGRESS";
    mockSearchQuery = "존재하지않는검색어";
    const { container } = render(
      <CrmDashboard initialData={makeInitialData(sampleCampaigns)} lockedStageFilter="PROGRESS" />,
    );
    const quick = screen.getByRole("button", { name: /^전체 처리/ });
    const toolbar = quick.parentElement!.parentElement as HTMLElement;
    expect(within(toolbar).getByText("조건에 맞는 캠페인 없음")).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "필터 초기화" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("textbox", { name: "캠페인 검색" })).toBeInTheDocument();
    // 검색을 치는 순간 보드 위에 적용 중 필터 줄이 생기면 보드·검색칸이 아래로 밀린다(화면 튐).
    expect(container.querySelector('[data-slot="pipeline-card-head"]')).toBeNull();
  });

  it("defaults to kanban active state", () => {
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    expect(screen.getByRole("radio", { name: "칸반" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "테이블" })).toHaveAttribute("aria-checked", "false");
  });

  it("calls setViewMode('table') when table button is clicked", async () => {
    const user = userEvent.setup();
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    await user.click(screen.getByRole("radio", { name: "테이블" }));
    expect(mockSetViewMode).toHaveBeenCalledWith("table");
  });

  it("calls setViewMode('kanban') when kanban button is clicked", async () => {
    const user = userEvent.setup();
    mockViewMode = "table";
    render(<CrmDashboard initialData={makeInitialData(sampleCampaigns)} />);

    await user.click(screen.getByRole("radio", { name: "칸반" }));
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
    await user.click(screen.getByRole("radio", { name: "테이블" }));

    expect(mockSetStageFilter).not.toHaveBeenCalled();
    expect(mockSetTeamFilter).not.toHaveBeenCalled();
    expect(mockSetSearchQuery).not.toHaveBeenCalled();
  });
});
