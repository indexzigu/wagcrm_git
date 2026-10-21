// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 휴대폰 정산 화면에서 캠페인 상세 열기.
 *
 * 상세 부품이 데스크톱 분기에만 있어서 휴대폰에서는 카드를 눌러도, `/settlement?campaign=<id>` 로
 * 들어와도 아무것도 열리지 않았다(패널 상태만 바뀌고 그릴 부품이 없었다). 휴대폰 분기도 같은 선택
 * 상태·같은 닫기 핸들러로 모바일 상세 시트를 연다 — 닫으면 주소의 `campaign` 이 지워진다.
 */

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

const replaceState = vi.spyOn(window.history, "replaceState");
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/settlement",
  useSearchParams: () => search,
}));

type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: { id: string; dealName: string } | null;
};
let sheetProps: SheetProps | null = null;
vi.mock("@/components/mobile/mobile-campaign-detail-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/mobile/mobile-campaign-detail-sheet")>();
  return {
    ...actual,
    MobileCampaignDetailSheet: (props: SheetProps) => {
      sheetProps = props;
      return props.open && props.campaign ? (
        <div data-testid="mobile-sheet">
          <h2 data-testid="mobile-sheet-title">{props.campaign.dealName}</h2>
        </div>
      ) : null;
    },
  };
});

let viewProps: { onOpenCampaign: (campaign: CampaignRow) => void } | null = null;
vi.mock("@/components/mobile/mobile-settlement-view", () => ({
  MobileSettlementView: (props: { onOpenCampaign: (campaign: CampaignRow) => void }) => {
    viewProps = props;
    return null;
  },
}));
const sidePanel = vi.fn(() => null);
vi.mock("@/components/crm/campaign-side-panel", () => ({ CampaignSidePanel: () => sidePanel() }));

import { SettlementPageClient } from "../settlement-page-client";

function row(id: string): CampaignRow {
  return {
    id,
    status: "SETTLEMENT_IN_PROGRESS",
    dealName: `딜-${id}`,
    sellerName: "셀러",
    salesChannel: "SELLER_MALL",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    groupId: null,
  } as unknown as CampaignRow;
}

function initialData(campaigns: CampaignRow[]): DashboardData {
  return { campaigns, apiCallLogs: [], assets: [], storage: null } as unknown as DashboardData;
}

beforeEach(() => {
  replaceState.mockClear();
  sheetProps = null;
  viewProps = null;
  sidePanel.mockClear();
  search = new URLSearchParams();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports/settlement")) {
        return { ok: true, json: async () => ({ campaigns: [], summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0 } }) };
      }
      if (url === "/api/campaigns/early") return { ok: true, json: async () => row("early") };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("정산 페이지(휴대폰) — 캠페인 상세 열기", () => {
  it("주소의 campaign 으로 들어오면 모바일 상세 시트가 그 캠페인으로 열린다", async () => {
    search = new URLSearchParams("campaign=b");
    render(<SettlementPageClient initialData={initialData([row("a"), row("b")])} defaultMonth="2026-10" />);
    expect(await screen.findByTestId("mobile-sheet-title")).toHaveTextContent("딜-b");
    // 휴대폰에서 데스크톱 옆 창은 그리지 않는다.
    expect(sidePanel).not.toHaveBeenCalled();
  });

  it("정산 목록에 없는 캠페인(홈 리스크 카드의 정산 전 캠페인)은 서버에서 한 건 읽어 시트로 연다", async () => {
    search = new URLSearchParams("campaign=early");
    render(<SettlementPageClient initialData={initialData([row("a")])} defaultMonth="2026-10" />);
    expect(await screen.findByTestId("mobile-sheet-title")).toHaveTextContent("딜-early");
  });

  it("카드를 누르면 모바일 상세 시트가 열린다", async () => {
    render(<SettlementPageClient initialData={initialData([row("a")])} defaultMonth="2026-10" />);
    expect(screen.queryByTestId("mobile-sheet")).not.toBeInTheDocument();
    act(() => viewProps!.onOpenCampaign(row("a")));
    expect(await screen.findByTestId("mobile-sheet-title")).toHaveTextContent("딜-a");
  });

  it("시트를 닫으면 주소에서 campaign 만 지운다", async () => {
    search = new URLSearchParams("month=2026-09&campaign=b");
    render(<SettlementPageClient initialData={initialData([row("b")])} defaultMonth="2026-10" />);
    await screen.findByTestId("mobile-sheet");
    act(() => sheetProps!.onOpenChange(false));
    expect(screen.queryByTestId("mobile-sheet")).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settlement?month=2026-09");
  });
});
