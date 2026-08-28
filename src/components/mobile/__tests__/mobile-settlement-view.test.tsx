import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MobileSettlementView } from "../mobile-settlement-view";
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
