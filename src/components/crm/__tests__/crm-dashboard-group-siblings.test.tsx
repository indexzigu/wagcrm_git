// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
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

const mockViewMode: "kanban" | "table" = "kanban";
const mockStageFilter = "ALL";
const mockTeamFilter: string | null = null;
const mockSearchQuery = "";

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
// 패널은 이 테스트의 관심 밖 — 「행 하나가 저장됐다」 통지 창구만 노출한다.
let notifySaved: ((row: CampaignRow) => void) | null = null;
vi.mock("../campaign-side-panel", () => ({
  CampaignSidePanel: ({
    onCampaignUpdated,
  }: {
    onCampaignUpdated: (campaign: CampaignRow) => void;
  }) => {
    notifySaved = onCampaignUpdated;
    return null;
  },
}));
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

/**
 * 그룹 소속 캠페인을 저장하면 서버는 형제에도 반영하지만(정산 일정·플래그 = 그룹 스칼라,
 * 기간 = 팬아웃) 응답은 수정한 1건뿐이다 — 보드는 나머지 멤버를 다시 읽어야 한다.
 */
describe("CrmDashboard — 그룹 형제 행 재조회", () => {
  let campaignRequests: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    notifySaved = null;
    campaignRequests = [];
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const match = String(input).match(/^\/api\/campaigns\/([^/?]+)$/);
        if (match) {
          campaignRequests.push(match[1]);
          return {
            ok: true,
            json: async () => makeCampaign({ id: match[1], groupId: "g1" }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const campaigns = [
    makeCampaign({ id: "a", groupId: "g1" }),
    makeCampaign({ id: "b", groupId: "g1" }),
    makeCampaign({ id: "c", groupId: "g1" }),
    makeCampaign({ id: "solo" }),
  ];

  it("그룹 멤버 1건이 저장되면 나머지 멤버 전원을 다시 읽는다", async () => {
    render(<CrmDashboard initialData={makeInitialData(campaigns)} />);
    expect(notifySaved).not.toBeNull();

    await act(async () => {
      notifySaved!(makeCampaign({ id: "a", groupId: "g1", endDate: "2027-01-31" }));
    });

    await waitFor(() => expect([...campaignRequests].sort()).toEqual(["b", "c"]));
  });

  it("무그룹 캠페인 저장은 행 재조회를 만들지 않는다", async () => {
    render(<CrmDashboard initialData={makeInitialData(campaigns)} />);

    await act(async () => {
      notifySaved!(makeCampaign({ id: "solo", endDate: "2027-01-31" }));
    });

    expect(campaignRequests).toEqual([]);
  });
});
