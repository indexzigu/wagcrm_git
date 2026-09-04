// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignGroupMemberRow, CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { CampaignGroupSection } from "../campaign-group-section";

/**
 * 이미 묶인 그룹의 **멤버 목록**이 「이게 같은 묶음인가」를 판단할 축(브랜드·거래처)을
 * 싣는지 본다. 그 정보가 없어서 "같은 셀러·같은 일정인데 브랜드가 달라서 안 묶인다"는
 * 오진이 나왔고, 두 번째 케이스는 표기 조립을 화면이 다시 만들지 않는지를 고정한다.
 */

/** 그룹 소속 경로만 타므로 섹션이 실제로 읽는 필드만 채운다. */
function groupedCampaign(): CampaignRow {
  return {
    id: "c-current",
    sellerId: "s1",
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    groupId: "g1",
  } as unknown as CampaignRow;
}

function member(over: Partial<CampaignGroupMemberRow> = {}): CampaignGroupMemberRow {
  return {
    campaignId: "c-current",
    dealName: "비타민",
    campaignName: null,
    brandName: "뉴트리원",
    partnerName: "뷰티코리아",
    status: "PROPOSAL",
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    roundNumber: null,
    salesChannel: "SELLER_MALL",
    actualSales: null,
    sellerExpense: null,
    settlementItems: [],
    ...over,
  };
}

const fetchMock = vi.fn();

function stubDetail(members: CampaignGroupMemberRow[]) {
  fetchMock.mockImplementation((input: unknown) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    if (url.includes("/api/campaign-groups/g1")) {
      return json({
        id: "g1",
        sellerId: "s1",
        sellerName: "테스트셀러",
        name: null,
        startDate: "2026-08-18",
        endDate: "2026-08-21",
        memberCount: members.length,
        memberCampaignIds: members.map((m) => m.campaignId),
        members,
      });
    }
    return json(groupedCampaign());
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("그룹 멤버 목록 — 브랜드·거래처 표기", () => {
  it("멤버 행에 브랜드와 거래처를 함께 보여준다", async () => {
    stubDetail([member()]);
    render(<CampaignGroupSection campaign={groupedCampaign()} />);

    expect(await screen.findByText("뉴트리원 - 뷰티코리아")).toBeInTheDocument();
  });

  it("브랜드사가 곧 거래처면 하나만 보여준다 — 접기 규칙은 formatDealContextLabel 소유", async () => {
    // 화면이 표기를 직접 이어붙이면 이 케이스에서 "뉴트리원 - 뉴트리원"이 된다.
    // 이 레포가 반복해서 겪은 「정본 함수를 두고 호출부가 손으로 다시 만든다」 형태다.
    stubDetail([member({ brandName: "뉴트리원", partnerName: "뉴트리원" })]);
    render(<CampaignGroupSection campaign={groupedCampaign()} />);

    expect(await screen.findByText("뉴트리원")).toBeInTheDocument();
    expect(screen.queryByText("뉴트리원 - 뉴트리원")).not.toBeInTheDocument();
  });
});
