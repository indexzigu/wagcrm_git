// @vitest-environment jsdom
/**
 * tool-result-views — READ 도구 5종 리치 렌더 (청사진 §2, §3-#5).
 *
 * TOOL_RESULT_RENDERERS 레지스트리 + 각 뷰의 핵심 필드 렌더를 검증한다.
 * data는 unknown으로 받아 런타임 가드(필수 필드 존재 체크) 후 렌더하므로,
 * 필드가 없거나 null인 경우 컴포넌트가 null을 반환하는지도 함께 검증한다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_RENDERERS, TOOL_RESULT_GUARD_NAMES } from "../tool-result-views";
import type {
  GetSettlementReportData,
  SearchDealsData,
  SearchPartnersData,
  GetPipelineStatusData,
  GetCampaignFinancialsData,
  GetOrderSnapshotData,
} from "@/lib/agent/tools/data-types";

describe("TOOL_RESULT_RENDERERS 레지스트리", () => {
  it("6개 도구명이 모두 등록되어 있다", () => {
    expect(Object.keys(TOOL_RESULT_RENDERERS).sort()).toEqual(
      [
        "get_settlement_report",
        "search_deals",
        "search_partners",
        "get_pipeline_status",
        "get_campaign_financials",
        "get_order_snapshot",
      ].sort()
    );
  });

  it("미지 toolName은 레지스트리에 없다", () => {
    expect(TOOL_RESULT_RENDERERS["unknown_tool"]).toBeUndefined();
  });

  // 뷰만 더하고 가드를 빠뜨리면 그 뷰는 결재함 상세에서 영영 안 불린다 — 화면은
  // 조용히 제네릭 표가 되고, 고장처럼 보이지 않아서 더 오래 간다.
  it("가드 표는 레지스트리와 같은 도구 목록을 갖는다", () => {
    expect([...TOOL_RESULT_GUARD_NAMES].sort()).toEqual(Object.keys(TOOL_RESULT_RENDERERS).sort());
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

describe("search_partners 뷰", () => {
  const View = TOOL_RESULT_RENDERERS["search_partners"];

  const sampleData: SearchPartnersData = {
    items: [
      { id: "p1", name: "거래처A", type: "VENDOR", businessNumber: "123-45-67890", updatedAt: "2026-09-01T00:00:00Z" },
      { id: "p2", name: "거래처B", type: "BRAND", businessNumber: null, updatedAt: "2026-08-01T00:00:00Z" },
    ],
    count: 2,
    truncated: false,
  };

  it("상호·구분(한글 라벨)·사업자번호를 표로 렌더한다", () => {
    render(<View data={sampleData} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("벤더")).toBeInTheDocument();
    expect(screen.getByText("123-45-67890")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("상호는 그 거래처 상세로 가는 링크다", () => {
    render(<View data={sampleData} />);
    expect(screen.getByRole("link", { name: "거래처A" })).toHaveAttribute(
      "href",
      "/partners?selectedPartner=p1"
    );
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

// 결재함 상세(Plan 2 Task 5)는 이 뷰들을 **자기 카드 안에** 얹는다 — 뷰가 테두리를
// 한 겹 더 그리면 카드 속 카드가 된다. `bare` 는 그 한 겹만 끈다(내용은 그대로).
describe("bare — 상세 화면 안에서는 테두리 한 겹을 끈다", () => {
  const View = TOOL_RESULT_RENDERERS["get_pipeline_status"];
  const sampleData: GetPipelineStatusData = {
    statusCounts: [{ status: "ACTIVE", count: 3 }],
    totalCount: 3,
    campaigns: [],
  };

  it("기본은 테두리가 있고, bare 면 없다", () => {
    const { container: plain } = render(<View data={sampleData} />);
    expect((plain.firstElementChild as HTMLElement).className).toContain("border-border");

    const { container: bare } = render(<View data={sampleData} bare />);
    const bareClass = (bare.firstElementChild as HTMLElement).className;
    expect(bareClass).not.toContain("border-border");
    // 바깥 껍데기와 함께 「앞 메시지와 띄우던」 여백도 끈다 — 상세에선 위가 카드 머리다.
    expect(bareClass).not.toContain("mt-2");
    // 내용은 그대로다 — 끄는 것은 껍데기뿐이다.
    expect(bareClass).toContain("flex-col");
  });
});
