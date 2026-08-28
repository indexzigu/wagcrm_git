/**
 * tool-result-views — READ 도구 5종 리치 렌더 (청사진 §2, §3-#5).
 *
 * TOOL_RESULT_RENDERERS 레지스트리 + 각 뷰의 핵심 필드 렌더를 검증한다.
 * data는 unknown으로 받아 런타임 가드(필수 필드 존재 체크) 후 렌더하므로,
 * 필드가 없거나 null인 경우 컴포넌트가 null을 반환하는지도 함께 검증한다.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TOOL_RESULT_RENDERERS } from "../tool-result-views";
import type {
  GetSettlementReportData,
  SearchDealsData,
  GetPipelineStatusData,
  GetCampaignFinancialsData,
  GetOrderSnapshotData,
} from "@/lib/agent/tools/data-types";

describe("TOOL_RESULT_RENDERERS 레지스트리", () => {
  it("5개 도구명이 모두 등록되어 있다", () => {
    expect(Object.keys(TOOL_RESULT_RENDERERS).sort()).toEqual(
      [
        "get_settlement_report",
        "search_deals",
        "get_pipeline_status",
        "get_campaign_financials",
        "get_order_snapshot",
      ].sort()
    );
  });

  it("미지 toolName은 레지스트리에 없다", () => {
    expect(TOOL_RESULT_RENDERERS["unknown_tool"]).toBeUndefined();
  });
});

describe("get_settlement_report 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["get_settlement_report"];

  const sampleData: GetSettlementReportData = {
    period: "2026-07",
    summary: { totalRevenue: 1000000, totalMargin: 200000, totalSellerPayouts: 300000, campaignCount: 1 },
    campaigns: [
      {
        id: "camp1",
        dealName: "락토핏 골드",
        brandName: "락토핏",
        sellerName: "셀러A",
        actualSales: 1000000,
        sellerPayoutAmount: 300000,
        netMarginAmount: 200000,
        state: "confirmed",
        isDepositReceived: true,
        isPayoutCompleted: false,
        depositReceivedAt: "2026-07-10T00:00:00Z",
        payoutCompletedAt: null,
      },
    ],
    stateCounts: { pending: 0, confirmed: 1, paid: 0 },
  };

  it("요약 스탯 4개(총매출·총마진·셀러지급·건수)와 캠페인 테이블을 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getAllByText("1,000,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("200,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("300,000").length).toBeGreaterThan(0);
    expect(screen.getByText("락토핏 골드")).toBeInTheDocument();
    expect(screen.getByText("셀러A")).toBeInTheDocument();
  });

  it("data가 null이면 렌더하지 않는다", () => {
    const { container } = render(<View data={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("필수 필드(summary)가 없으면 렌더하지 않는다", () => {
    const { container } = render(<View data={{ period: "2026-07" }} />);
    expect(container.firstChild).toBeNull();
  });
});

// 청사진 §7-2/§7-3: 정산 리포트 캠페인 행 액션(상태별 기안 요청 퀵액션).
describe("get_settlement_report 뷰 — 행 액션 (§7-2)", () => {
  const View = TOOL_RESULT_RENDERERS["get_settlement_report"];

  function dataWithState(state: "pending" | "confirmed" | "paid"): GetSettlementReportData {
    return {
      period: "2026-07",
      summary: { totalRevenue: 1000000, totalMargin: 200000, totalSellerPayouts: 300000, campaignCount: 1 },
      campaigns: [
        {
          id: "camp1",
          dealName: "락토핏 골드",
          brandName: "락토핏",
          sellerName: "셀러A",
          actualSales: 1000000,
          sellerPayoutAmount: 300000,
          netMarginAmount: 200000,
          state,
          isDepositReceived: state !== "pending",
          isPayoutCompleted: state === "paid",
          depositReceivedAt: state !== "pending" ? "2026-07-10T00:00:00Z" : null,
          payoutCompletedAt: state === "paid" ? "2026-07-15T00:00:00Z" : null,
        },
      ],
      stateCounts: { pending: 0, confirmed: 0, paid: 0, [state]: 1 } as Record<
        GetSettlementReportData["campaigns"][number]["state"],
        number
      >,
    };
  }

  it("state=pending이면 [입금확정 기안] 버튼을 렌더한다", () => {
    render(<View data={dataWithState("pending")} onQuickAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "입금확정 기안" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "지급완료 기안" })).not.toBeInTheDocument();
  });

  it("state=confirmed이면 [지급완료 기안] 버튼을 렌더한다", () => {
    render(<View data={dataWithState("confirmed")} onQuickAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "지급완료 기안" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "입금확정 기안" })).not.toBeInTheDocument();
  });

  it("state=paid이면 버튼이 없다", () => {
    render(<View data={dataWithState("paid")} onQuickAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "입금확정 기안" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "지급완료 기안" })).not.toBeInTheDocument();
  });

  it("onQuickAction 미제공 시 pending 행이라도 버튼이 렌더되지 않는다", () => {
    render(<View data={dataWithState("pending")} />);
    expect(screen.queryByRole("button", { name: "입금확정 기안" })).not.toBeInTheDocument();
  });

  it("[입금확정 기안] 클릭 시 dealName+ID 포함 문장으로 onQuickAction을 호출한다", () => {
    const onQuickAction = vi.fn();
    render(<View data={dataWithState("pending")} onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByRole("button", { name: "입금확정 기안" }));
    expect(onQuickAction).toHaveBeenCalledWith(
      '"락토핏 골드" 캠페인(ID: camp1)의 정산 입금확정 처리를 기안해줘'
    );
  });

  it("[지급완료 기안] 클릭 시 dealName+ID 포함 문장으로 onQuickAction을 호출한다", () => {
    const onQuickAction = vi.fn();
    render(<View data={dataWithState("confirmed")} onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByRole("button", { name: "지급완료 기안" }));
    expect(onQuickAction).toHaveBeenCalledWith(
      '"락토핏 골드" 캠페인(ID: camp1)의 정산 지급완료 처리를 기안해줘'
    );
  });
});

// 청사진 §7-3: 다른 4개 뷰는 onQuickAction prop을 받아도 무동작(버튼 없음) — presentational
// 순수성 확인. prop을 넘겨도 회귀 없이 기존 렌더 그대로 유지되는지 검증한다.
describe("다른 4개 뷰 — onQuickAction prop 통과만(무동작)", () => {
  it("search_deals 뷰는 onQuickAction을 받아도 버튼을 렌더하지 않는다", () => {
    const View = TOOL_RESULT_RENDERERS["search_deals"];
    const sampleData: SearchDealsData = {
      items: [
        {
          id: "deal1",
          dealName: "락토핏 골드",
          brandName: "락토핏",
          status: "NEGOTIATING",
          sellingPrice: 10000,
          costPrice: 5000,
          partnerName: "파트너A",
          updatedAt: "2026-07-01T00:00:00Z",
        },
      ],
      count: 1,
      truncated: false,
    };
    render(<View data={sampleData} onQuickAction={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("get_pipeline_status 뷰는 onQuickAction을 받아도 버튼을 렌더하지 않는다", () => {
    const View = TOOL_RESULT_RENDERERS["get_pipeline_status"];
    const sampleData: GetPipelineStatusData = {
      statusCounts: [{ status: "ACTIVE", count: 3 }],
      totalCount: 3,
      campaigns: [],
    };
    render(<View data={sampleData} onQuickAction={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("get_campaign_financials 뷰는 onQuickAction을 받아도 버튼을 렌더하지 않는다", () => {
    const View = TOOL_RESULT_RENDERERS["get_campaign_financials"];
    const sampleData: GetCampaignFinancialsData = {
      campaignId: "camp1",
      dealName: "락토핏 골드",
      sellerName: "셀러A",
      status: "ACTIVE",
      actualSales: 1000000,
      derived: { settlementSales: 900000, sellerExpense: 300000, taxExpense: 30000, operatingProfit: 570000 },
      isDepositReceived: false,
      isPayoutCompleted: false,
    };
    render(<View data={sampleData} onQuickAction={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("get_order_snapshot 뷰는 onQuickAction을 받아도 버튼을 렌더하지 않는다", () => {
    const View = TOOL_RESULT_RENDERERS["get_order_snapshot"];
    const sampleData: GetOrderSnapshotData = {
      days: [
        { snapshotDate: "2026-07-01", ordersCount: 10, newOrdersCount: 3, preparingCount: 2, deliveringCount: 5, lastCallTime: "2026-07-01T09:00:00Z" },
      ],
      totals: { ordersCount: 10, newOrdersCount: 3, preparingCount: 2, deliveringCount: 5 },
    };
    render(<View data={sampleData} onQuickAction={vi.fn()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("search_deals 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["search_deals"];

  const sampleData: SearchDealsData = {
    items: [
      {
        id: "deal1",
        dealName: "락토핏 골드",
        brandName: "락토핏",
        status: "NEGOTIATING",
        sellingPrice: 10000,
        costPrice: 5000,
        partnerName: "파트너A",
        updatedAt: "2026-07-01T00:00:00Z",
      },
    ],
    count: 1,
    truncated: false,
  };

  it("딜 리스트(딜명·상태·브랜드)와 count를 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getByText("락토핏 골드")).toBeInTheDocument();
    expect(screen.getByText("락토핏")).toBeInTheDocument();
  });

  it("truncated=true면 '상위 20건' 안내를 보여준다", () => {
    render(<View data={{ ...sampleData, truncated: true }} />);
    expect(screen.getByText(/상위 20건/)).toBeInTheDocument();
  });

  it("data가 null이면 렌더하지 않는다", () => {
    const { container } = render(<View data={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("필수 필드(items)가 없으면 렌더하지 않는다", () => {
    const { container } = render(<View data={{ count: 1 }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("get_pipeline_status 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["get_pipeline_status"];

  const sampleData: GetPipelineStatusData = {
    statusCounts: [
      { status: "ACTIVE", count: 3 },
      { status: "CLOSED", count: 1 },
    ],
    totalCount: 4,
    campaigns: [
      { id: "camp1", dealName: "락토핏 골드", sellerName: "셀러A", status: "ACTIVE", startDate: "2026-07-01", endDate: "2026-07-31" },
    ],
  };

  it("단계별 카운트 뱃지와 totalCount, campaigns 목록을 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getAllByText(/ACTIVE/).length).toBeGreaterThan(0);
    expect(screen.getByText(/CLOSED/)).toBeInTheDocument();
    expect(screen.getByText(/총 4건/)).toBeInTheDocument();
    expect(screen.getByText("락토핏 골드")).toBeInTheDocument();
  });

  it("data가 null이면 렌더하지 않는다", () => {
    const { container } = render(<View data={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("필수 필드(statusCounts)가 없으면 렌더하지 않는다", () => {
    const { container } = render(<View data={{ totalCount: 1 }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("get_campaign_financials 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["get_campaign_financials"];

  const sampleData: GetCampaignFinancialsData = {
    campaignId: "camp1",
    dealName: "락토핏 골드",
    sellerName: "셀러A",
    status: "ACTIVE",
    actualSales: 1000000,
    derived: { settlementSales: 900000, sellerExpense: 300000, taxExpense: 30000, operatingProfit: 570000 },
    isDepositReceived: false,
    isPayoutCompleted: false,
  };

  it("스탯 그리드(실매출·정산매출·셀러지급·세금·영업이익)와 캡션을 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getByText("1,000,000")).toBeInTheDocument();
    expect(screen.getByText("900,000")).toBeInTheDocument();
    expect(screen.getByText("570,000")).toBeInTheDocument();
  });

  it("'파생 계산값 — 정산 확정치 아님' 캡션이 존재한다 (3중 방어 유지 필수)", () => {
    render(<View data={sampleData} />);
    expect(screen.getByText(/파생 계산값/)).toBeInTheDocument();
    expect(screen.getByText(/정산 확정치 아님/)).toBeInTheDocument();
  });

  // 완료 hue 계약(P8 §4 — 브랜드 네이비 틴트를 판정 의미로 쓰는 것 금지, 오너 승인 2026-08-26).
  // ⛔ status-active(네이비)로 되돌리면 여기서 빨강. 근거 정본은 proposal-card StatusChip 주석.
  function badgeVariantsByText(container: HTMLElement): Map<string, string | null> {
    const badges = Array.from(container.querySelectorAll('[data-slot="badge"]'));
    return new Map(
      badges.map((b) => [
        (b.textContent ?? "").replace(/\s+/g, " ").trim(),
        b.getAttribute("data-variant"),
      ])
    );
  }

  it("완료 배지는 status-success, 대기 배지는 무채 outline 이다", () => {
    const { container } = render(
      <View data={{ ...sampleData, isDepositReceived: true, isPayoutCompleted: false }} />
    );
    const variants = badgeVariantsByText(container);

    expect(variants.get("입금 완료")).toBe("status-success");
    // 아직 안 일어난 일은 무채 — P8 §2. ⛔ status-pending 으로 올리지 말 것.
    expect(variants.get("지급 대기")).toBe("outline");
  });

  it("입금·지급 둘 다 완료면 배지 둘 다 status-success 다", () => {
    const { container } = render(
      <View data={{ ...sampleData, isDepositReceived: true, isPayoutCompleted: true }} />
    );
    const variants = badgeVariantsByText(container);

    expect(variants.get("입금 완료")).toBe("status-success");
    expect(variants.get("지급 완료")).toBe("status-success");
  });

  it("data가 null이면 렌더하지 않는다", () => {
    const { container } = render(<View data={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("필수 필드(derived)가 없으면 렌더하지 않는다", () => {
    const { container } = render(<View data={{ campaignId: "camp1" }} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("get_order_snapshot 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["get_order_snapshot"];

  const sampleData: GetOrderSnapshotData = {
    days: [
      { snapshotDate: "2026-07-01", ordersCount: 10, newOrdersCount: 3, preparingCount: 2, deliveringCount: 5, lastCallTime: "2026-07-01T09:00:00Z" },
    ],
    totals: { ordersCount: 10, newOrdersCount: 3, preparingCount: 2, deliveringCount: 5 },
  };

  it("totals 4칩(주문/신규/준비/배송중)과 일자별 테이블을 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
  });

  it("data가 null이면 렌더하지 않는다", () => {
    const { container } = render(<View data={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("필수 필드(totals)가 없으면 렌더하지 않는다", () => {
    const { container } = render(<View data={{ days: [] }} />);
    expect(container.firstChild).toBeNull();
  });
});
