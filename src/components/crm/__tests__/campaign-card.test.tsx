import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CampaignCard } from "../campaign-card";
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
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

const noop = () => {};



// ---------------------------------------------------------------------------
// Tests: Urgency indicators (Requirement 12.5)
// ---------------------------------------------------------------------------

describe("CampaignCard — Urgency indicators", () => {
  // 2026-07-16: 색은 그대로 심각도 축에 있고, 표현만 리터럴 → --status-* 토큰으로 옮겼다.
  // 원색이 아니라 어두운 변형인 이유는 이 텍스트가 흰 카드 위 10px 소형이라서다
  // (--status-urgent 4.69 는 AA 경계 → --status-urgent-text 7.29 · 구 orange-500 은 2.80 로 미달이었다).
  it("applies urgent token color for overdue campaigns (endDate in the past)", () => {
    const pastDate = "2020-01-01";
    render(
      <CampaignCard
        campaign={makeCampaign({ startDate: "2019-12-01", endDate: pastDate })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );

    // 날짜 텍스트는 색상 클래스를 가진 외곽 span 안의 truncate span에 렌더되므로
    // 부모(외곽 span)에서 urgency 색상 클래스를 확인한다.
    const dateSpan = screen.getByText("12.01 ~ 01.01").parentElement;
    expect(dateSpan).toHaveClass("text-status-urgent-text");
  });

  it("applies caution token color for imminent campaigns (endDate within 3 days)", () => {
    // Set endDate to tomorrow relative to "now"
    const now = new Date();
    const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    render(
      <CampaignCard
        campaign={makeCampaign({ startDate: startStr, endDate: tomorrowStr })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );

    // Find the date range element — it should have the imminent (caution token) text class
    const startMonth = String(new Date(startStr).getMonth() + 1).padStart(2, "0");
    const startDay = String(new Date(startStr).getDate()).padStart(2, "0");
    const endMonth = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const endDay = String(tomorrow.getDate()).padStart(2, "0");
    const expectedText = `${startMonth}.${startDay} ~ ${endMonth}.${endDay}`;

    const dateSpan = screen.getByText(expectedText).parentElement;
    expect(dateSpan).toHaveClass("text-status-caution");
  });

  it("applies muted text color for normal campaigns (endDate far in the future)", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ startDate: "2026-01-01", endDate: "2026-12-31" })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );

    const dateSpan = screen.getByText("01.01 ~ 12.31").parentElement;
    expect(dateSpan).toHaveClass("text-muted-foreground");
  });

  it("applies muted text color when endDate is unset (null)", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ startDate: null as unknown as string, endDate: null as unknown as string })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );

    const dateSpan = screen.getByText("일정 미정").parentElement;
    expect(dateSpan).toHaveClass("text-muted-foreground");
  });
});

// ---------------------------------------------------------------------------
// Tests: Primary content — seller name + deal name (Requirement 12.4)
// ---------------------------------------------------------------------------

describe("CampaignCard — Primary content", () => {
  it("displays deal name as primary content", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ dealName: "글로우 앰플 5차 공구", sellerName: "뷰티크리에이터" })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.getByText("글로우 앰플 5차 공구")).toBeInTheDocument();
  });

  it("displays seller and deal context under the title", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ sellerName: "뷰티크리에이터", dealName: "글로우 앰플 5차 공구" })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.getByText("글로우 앰플 5차 공구")).toBeInTheDocument();
    expect(screen.getByText("뷰티크리에이터")).toBeInTheDocument();
  });

  it("displays deal name and separates round number into a badge when present", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ roundNumber: 3, dealName: "글로우 앰플 5차 공구" })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.getByText("글로우 앰플 5차 공구")).toBeInTheDocument();
    expect(screen.getByText("3차")).toBeInTheDocument();
  });

  it("does not render a campaign-level revenue goal", () => {
    render(
      <CampaignCard
        campaign={makeCampaign()}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.queryByText(/목표 매출/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: 최저가 위반 배지 (UX1-C) — 날짜 비의존
// ---------------------------------------------------------------------------

describe("CampaignCard — 최저가 위반 배지 (UX1-C)", () => {
  it("hasPriceViolation=true면 위반 배지를 렌더링한다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ hasPriceViolation: true, violatedDealCount: 1 })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.getByText("최저가 위반")).toBeInTheDocument();
  });

  it("위반 딜 개수를 hover 안내(title)로 노출한다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ hasPriceViolation: true, violatedDealCount: 3 })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    const badge = screen.getByText("최저가 위반");
    expect(badge.closest("[title]")).toHaveAttribute("title", expect.stringContaining("3"));
  });

  it("hasPriceViolation=false면 위반 배지를 렌더링하지 않는다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ hasPriceViolation: false, violatedDealCount: 0 })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.queryByText("최저가 위반")).not.toBeInTheDocument();
  });

  it("hasPriceViolation 필드 자체가 없는(스냅샷 無) 기존 캠페인은 배지가 없다 (기본 상태와 동일)", () => {
    render(
      <CampaignCard
        campaign={makeCampaign()}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.queryByText("최저가 위반")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: CG-1 그룹 배지 (표면 ⓓ)
// ---------------------------------------------------------------------------

describe("CampaignCard — CG-1 그룹 배지", () => {
  it("groupId + groupMemberCount가 있으면 멤버 수와 sr-only 접근명을 렌더링한다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ groupId: "grp-1", groupMemberCount: 3 })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    // 접근명(색+숫자 병기, sr-only)
    expect(screen.getByText("조합 그룹 3건 소속")).toBeInTheDocument();
    // 툴팁(title)에 개수 포함
    const badge = screen.getByText("조합 그룹 3건 소속").closest("[title]");
    expect(badge).toHaveAttribute("title", "이 셀러의 조합 그룹 · 3건");
  });

  it("groupMemberCount 미제공(계약 갭) 시 아이콘만 — 숫자 없이 degrade한다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign({ groupId: "grp-1" })}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.getByText("조합 그룹 소속")).toBeInTheDocument();
    // 카운트 접근명(N건 소속)은 없어야 한다.
    expect(screen.queryByText(/조합 그룹 \d+건 소속/)).not.toBeInTheDocument();
  });

  it("groupId가 없으면(미그룹) 그룹 배지를 렌더링하지 않는다", () => {
    render(
      <CampaignCard
        campaign={makeCampaign()}
        onOpen={noop}
        onDelete={noop}
        onDuplicate={noop}
      />,
    );
    expect(screen.queryByText(/조합 그룹/)).not.toBeInTheDocument();
  });
});
