// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MobileSettlementView } from "../mobile-settlement-view";
import { buildSettlementPending } from "../mobile-settlement-pending-sheet";
import type { CampaignRow } from "@/lib/crm-types";
import type { SettlementReportData } from "@/lib/settlement-report";

const campaign: CampaignRow = {
  id: "camp-1",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: null,
  dealName: "보조배터리",
  partnerName: "명성",
  sellerName: "쁘띠 오가명",
  snsType: "INSTAGRAM",
  snsHandle: "@gaon",
  startDate: "2026-05-17",
  endDate: "2026-05-26",
  salesChannel: "OWN_MALL",
  baseNaverLink: "",
  generatedTrackingLink: "",
  actualSales: 10_000_000,
  settlementSales: 2_500_000,
  sellerExpense: 1_500_000,
  operatingProfit: 800_000,
  totalMarginRate: 30,
  sellerMarginRate: 15,
  netMarginRate: 15,
  status: "SETTLEMENT_IN_PROGRESS",
  isManualMargin: false,
  isDepositReceived: false,
  isPayoutCompleted: false,
  expectedDepositDate: "2026-06-12",
  expectedPayoutDate: "2026-06-22",
  assignedTo: null,
  updatedAt: "2026-06-01T00:00:00.000Z",
  deal: {
    brandName: "보바",
    costPrice: 0,
    sellingPrice: 0,
  },
  followerHistory: [],
  activityHistory: [],
  notes: [],
};

const reportData: SettlementReportData = {
  month: "2026-05",
  summary: {
    totalRevenue: 10_000_000,
    totalMargin: 2_500_000,
    totalSellerPayouts: 1_500_000,
    campaignCount: 1,
  },
  campaigns: [],
};

describe("MobileSettlementView", () => {
  it("keeps settlement mobile briefing independent from desktop breakpoints", () => {
    const { container } = render(
      <MobileSettlementView
        reportData={reportData}
        campaigns={[campaign]}
        selectedMonth="2026-05"
        viewType="month"
        selectedYear="2026"
        localQuery=""
        setLocalQuery={vi.fn()}
        commitSearch={vi.fn()}
        onOpenCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        onRetryLoad={vi.fn()}
        loading={false}
      />,
    );

    expect(screen.getByText("정산 확인")).toBeInTheDocument();
    expect(screen.getByText(/입금 대기/)).toBeInTheDocument();
    expect(screen.getByText(/지급 대기/)).toBeInTheDocument();
    // 이 픽스처는 **자사몰**(OWN_MALL)이다 — 슬롯이 [공급사 지급, 셀러 지급]이라 입금
    // 칸이 없다. 종전에는 `!isDepositReceived` 하나로 갈라서 자사몰 전건이 「몰 정산금
    // 입금 확인 필요」에 **영구 상주**했고, 선행 조건인 입금 플래그가 켜질 경로가 없어
    // 「지급 필요」에는 **영원히 못 들어왔다**(2026-08-25 2단계 회귀 단언).
    expect(screen.queryByText("입금 확인 필요")).not.toBeInTheDocument();
    expect(screen.getByText("지급 필요")).toBeInTheDocument();
    expect(screen.queryByText("정산 진행 중 캠페인")).not.toBeInTheDocument();
    expect(screen.queryByText("정산 완료 캠페인")).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("md:hidden");
  });
});

/**
 * 목록은 리포트로 걸러지므로 조회가 실패하거나 아직 안 왔으면 0건이 된다 — 그걸
 * 「정산 항목이 없습니다」로 그리면 이번 달이 비었다고 오판한다(interfaces 점검 #9).
 */
describe("MobileSettlementView — 실패·대기는 빈 목록이 아니다", () => {
  const baseProps = {
    reportData: null,
    campaigns: [] as CampaignRow[],
    selectedMonth: "2026-05",
    viewType: "month" as const,
    selectedYear: "2026",
    localQuery: "",
    setLocalQuery: vi.fn(),
    commitSearch: vi.fn(),
    onOpenCampaign: vi.fn(),
  };
  const EMPTY_TEXT = "조회 조건에 맞는 정산 항목이 없습니다.";

  it("조회 실패면 복구 안내와 44px 「다시 불러오기」를 보이고 빈 문구는 숨긴다", () => {
    const onRefresh = vi.fn(async () => {});
    const onRetryLoad = vi.fn();
    render(
      <MobileSettlementView
        {...baseProps}
        onRefresh={onRefresh}
        onRetryLoad={onRetryLoad}
        loading={false}
        loadError
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("정산 목록을 불러오지 못했습니다.");
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
    // 리포트가 없으면 대기 금액을 모른다 — ₩0 이 아니라 「-」.
    expect(screen.getByText(/입금 대기/)).toHaveTextContent("입금 대기 -");
    expect(screen.getByText(/지급 대기/)).toHaveTextContent("지급 대기 -");
    const retry = screen.getByRole("button", { name: "다시 불러오기" });
    expect(retry).toHaveClass("h-11");
    fireEvent.click(retry);
    // 리포트만 다시 조회한다 — 캠페인 목록 조회(onRefresh)를 거치면 그 실패가 복구를 막는다.
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("불러오는 중이면 빈 문구 대신 로딩 상태를 알린다", () => {
    render(
      <MobileSettlementView
        {...baseProps}
        onRefresh={vi.fn(async () => {})}
        onRetryLoad={vi.fn()}
        loading
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
  });
});

/**
 * 대기 합계는 데스크톱 정산 헤더·모바일 대기 시트·홈 자금 칩과 **같은 SSOT**
 * (`buildSettlementPending`)의 결과여야 한다 — 종전에는 이 화면만 `settlementSales`·
 * `sellerExpense` 를 손으로 더해서, 자사몰의 공급사 지급 다리가 빠지고 셀러몰 입금 근거도
 * 달라 같은 달인데 데스크톱과 숫자가 갈렸다.
 */
describe("MobileSettlementView — 대기 합계는 슬롯 SSOT 와 같다", () => {
  const row = (id: string, overrides: Partial<CampaignRow>): CampaignRow => ({
    ...campaign,
    id,
    settlementSales: 0,
    isSupplierPayoutCompleted: false,
    ...overrides,
  });

  it("공급사 지급 다리와 조합 캠페인이 섞여도 SSOT 합계를 그대로 적는다", () => {
    const campaigns = [
      // 자사몰 = [공급사 지급, 셀러 지급]. 셀러 지급은 끝났고 공급사 지급만 남았다.
      row("own", {
        salesChannel: "OWN_MALL",
        actualSales: 1_000_000,
        sellerExpense: 100_000,
        settlementGoodsCost: 600_000,
        isPayoutCompleted: true,
      }),
      // 셀러몰 조합 캠페인(멤버 2건) — 입금 근거가 `settlementSales` 가 아니다.
      row("grp-a", {
        salesChannel: "SELLER_MALL",
        groupId: "grp-1",
        actualSales: 2_000_000,
        settlementSales: 300_000,
        sellerExpense: 50_000,
        settlementGoodsCost: 1_200_000,
      }),
      row("grp-b", {
        salesChannel: "SELLER_MALL",
        groupId: "grp-1",
        actualSales: 1_500_000,
        settlementSales: 200_000,
        sellerExpense: 40_000,
        settlementGoodsCost: 900_000,
      }),
    ];
    const expected = buildSettlementPending(campaigns, "");
    // 양성 대조 — 픽스처가 옛 손수 식과 실제로 갈려야 이 단언이 회귀를 잡는다.
    const legacyDeposit = campaigns
      .filter((c) => c.salesChannel !== "OWN_MALL" && !c.isDepositReceived)
      .reduce((sum, c) => sum + (c.settlementSales || 0), 0);
    const legacyPayout = campaigns
      .filter((c) => !c.isPayoutCompleted)
      .reduce((sum, c) => sum + (c.sellerExpense || 0), 0);
    expect(expected.deposit.total).toBeGreaterThan(0);
    expect(expected.payout.total).toBeGreaterThan(0);
    expect(expected.deposit.total).not.toBe(legacyDeposit);
    expect(expected.payout.total).not.toBe(legacyPayout);

    render(
      <MobileSettlementView
        reportData={reportData}
        campaigns={campaigns}
        selectedMonth="2026-05"
        viewType="month"
        selectedYear="2026"
        localQuery=""
        setLocalQuery={vi.fn()}
        commitSearch={vi.fn()}
        onOpenCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        onRetryLoad={vi.fn()}
        loading={false}
      />,
    );

    const won = (n: number) => `₩${Math.round(n).toLocaleString()}`;
    expect(screen.getByText(/입금 대기/)).toHaveTextContent(
      `입금 대기 ${won(expected.deposit.total)}`,
    );
    expect(screen.getByText(/지급 대기/)).toHaveTextContent(
      `지급 대기 ${won(expected.payout.total)}`,
    );
  });
});
