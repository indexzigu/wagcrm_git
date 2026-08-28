import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MobileCampaignCard } from "../mobile-campaign-card";
import type { CampaignRow } from "@/lib/crm-types";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: null,
    dealName: "글로우 앰플 4차",
    partnerName: "코링코",
    sellerName: "미나",
    snsType: "INSTAGRAM",
    snsHandle: "@mina_beauty",
    startDate: "2026-01-15",
    endDate: "2026-01-31",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "https://example.com",
    actualSales: 3200000,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-01-10T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    deal: {
      costPrice: 0,
      sellingPrice: 0,
      brandName: "코링코 브랜드",
    },
    ...overrides,
  } as CampaignRow;
}

describe("Campaign identity badges", () => {
  it("shows seller and brand identity in mobile campaign cards", () => {
    render(
      <MobileCampaignCard
        campaign={makeCampaign()}
        onOpen={vi.fn()}
      />,
    );

    // 모바일 카드는 "셀러"/"브랜드" 텍스트 라벨을 쓰지 않는다. 일정탭 v3.3
    // 개편(item 7)에서 일정 리스트/상세 시트와 동일한 아이콘+뮤트 인라인
    // 패턴으로 통일되어, 셀러는 UserRound 아이콘 + 셀러명, 브랜드는
    // "· 브랜드명" 형태로 노출된다. 따라서 라벨 텍스트가 아니라 실제 노출되는
    // 셀러/브랜드 값 자체를 검증한다.
    expect(screen.getByText("미나")).toBeInTheDocument();
    // 브랜드는 "· 코링코 브랜드"로 렌더되므로 부분 일치로 확인한다.
    expect(screen.getByText("코링코 브랜드", { exact: false })).toBeInTheDocument();
  });
});
